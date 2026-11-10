import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsModal, type SettingsTab } from './SettingsModal';
import type { McpStatus, MemoryStats, ProviderStatus } from '../../types';

/**
 * Task 24b-A + M7 (round 3) — bất biến ĐƯỜNG DÂY của hộp Settings, trên MỘT seam duy nhất.
 *
 * File này là kết quả gộp: bản cũ cùng tên mock `lib/api` bằng `vi.mock` và re-test ít chính xác hơn
 * những gì đo được ở đây. Seam mock-`api` không phát biểu được A1/A3/A6/A7/A10 — nó cắt đúng tầng cần
 * đo: đường dẫn HTTP, verb, body và header `X-Morphi-Token`. Nên ở đây chỉ mock `lib/token`
 * (thứ Electron-only), còn `lib/api` + `fetch` sống nguyên, vì vậy "không có key nào lên HTTP" là một
 * PHÉP ĐO trên mọi request đã phát, chứ không phải một lời hứa trên spy. Danh sách 11 test của bản mock
 * và nơi phủ từng assertion nằm ở `task-24-fix3-report.md` (M7); một test duy nhất của bản đó không có
 * đường tương ứng — "bấm chuột đổi panel" — đã được port vào describe đầu file.
 *
 * Comment tiếng Việt theo luật của repo; mỗi comment nói vì sao assert có răng, không mô tả lại code.
 */

// Seam brief chốt: token là cầu nối Electron, transport thì thật.
vi.mock('../../lib/token', () => ({ getToken: async () => 'test-token' }));

/** Key GIẢ do test tự nghĩ ra — không đọc từ `auth.token`, `.env` hay két sắt thật nào cả. */
const SECRET = 'sk-sup3r-s3cret';

/**
 * Hình một API key. `[^a-z]` ở đầu để 'task-…' không khớp — nếu không, mọi chuỗi có 'sk-' sau một chữ
 * cái thường đều bị báo là lộ, và một sweep báo lỗi lung tung là sweep người ta tắt.
 */
const KEY_SHAPE = /(?:^|[^a-z])sk-[A-Za-z0-9_-]{8,}/g;

/**
 * m1 + m2: assert gốc của bản archived là `expect(document.body.innerHTML).not.toContain(SECRET)`. Nó chạy
 * xanh nhưng XANH SAI ở hai chỗ: (1) nó xanh VĨNH VIỄN với những test không hề đưa SECRET vào DOM (bridge
 * chỉ trả `{providerId, configured}`), và (2) nhận định "innerHTML mù với input controlled vì React giữ
 * giá trị ở property" là SỰ KIỆN SAI — round 4 đo lại: dán key rồi đọc `document.documentElement.outerHTML`
 * thì thấy nguyên chuỗi, React 19 mirror `value` thành content attribute. Một assert mà mù theo cách được
 * chọn thì không phải assert; đây là sweep có răng trên đúng hai kênh: hình-key trong HTML (chữ + thuộc
 * tính, trừ mirror `value`) và `value` thật của ô input.
 *
 * `extra` (nợ m4 round 3): KEY_SHAPE chỉ nhận dạng `sk-…`, tức một key Gemini `AIza…` in thẳng ra chữ thì
 * sweep làm ngơ — bất biến "không key nào vào DOM" không được phép phụ thuộc HÌNH của key. Test nào đưa
 * một literal không theo khuôn thì TRUYỀN nó vào đây, và kênh kiểm tra là literal đúng, không phải mẫu.
 *
 * `strippedHtml` là lý do phải tách kênh: React 19 mirror `value` của input controlled thành CONTENT
 * ATTRIBUTE (đo thật: dán key rồi đọc `document.documentElement.outerHTML` là thấy nguyên chuỗi), nên
 * quét HTML thô sẽ báo rò ngay tại lúc người dùng ĐANG GÕ — một false positive làm test đỏ vô nghĩa và
 * người ta sẽ tắt nó đi. Attribute `value` được gỡ trên bản clone; cái gì còn lại (chữ, placeholder,
 * thuộc tính khác) mới là "in ra DOM". Kênh property của `keyLeaks` vẫn soi `input.value` thật, tức một
 * key SỐNG SÓT sau khi đã ghi vẫn bị bắt.
 */
const strippedHtml = (): string => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    for (const input of clone.querySelectorAll('input')) input.removeAttribute('value');
    return clone.outerHTML;
};
const keyLeaks = (extra: string[] = []): string[] => {
    const html = strippedHtml();
    return [
        ...(html.match(KEY_SHAPE) ?? []),
        ...Array.from(document.querySelectorAll('input'))
            .flatMap((input) => input.value.match(KEY_SHAPE) ?? []),
        ...extra.filter((literal) => html.includes(literal)),
    ];
};

/**
 * jsdom không có `matchMedia` (GeneralPanel đọc nó qua `useTheme`) và `scrollIntoView`; cả hai được
 * chạm lúc mount nên phải stub TRƯỚC khi render — khuôn mẫu của `ChatInterface.test.tsx:35-41`.
 */
window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = vi.fn();

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const handlers = new Map<string, () => Response>();
const seen: { route: string; init?: RequestInit }[] = [];
/**
 * Nhật ký thứ tự thật của hai bước ở form thêm connector: `http:<id>` do handler PUT ghi, `ipc:<id>`
 * do bridge ghi. Không có nhật ký này thì "config trước, key sau" chỉ là một comment trong source.
 */
const order: string[] = [];

const routeOf = (url: string, init?: RequestInit): string =>
    `${(init?.method ?? 'GET').toUpperCase()} ${url.split('?')[0]}`;

const responder = vi.fn(async (url: unknown, init?: RequestInit) => {
    const route = routeOf(String(url), init);
    // Ghi TRƯỚC khi tra route: một request "lạc" phải hiện ra trong `seen` thay vì biến mất cùng
    // `throw`, nếu không phép đo "HTTP sạch key" sẽ xanh trên chính request mà nó canh.
    seen.push({ route, init });
    const handler = handlers.get(route);
    if (!handler) throw new Error(`unexpected fetch: ${route}`);
    return handler();
});
vi.stubGlobal('fetch', responder);

const routesOf = (): string[] => seen.map((entry) => entry.route);
const countOf = (route: string): number => seen.filter((entry) => entry.route === route).length;
const writesOf = (verb: string): string[] => routesOf().filter((route) => route.startsWith(`${verb} `));
const bodiesOf = (): string[] => seen.map((entry) => (typeof entry.init?.body === 'string' ? entry.init.body : ''));
const bodyOf = (route: string): unknown => {
    const entry = seen.find((item) => item.route === route);
    expect(entry, route).toBeDefined();
    return entry?.init?.body === undefined ? undefined : JSON.parse(String(entry.init.body));
};
/**
 * `:id` trên wire đi qua `encodeURIComponent` (`lib/api.ts:109`), nên một id connector tự hợp có `:`
 * hiện ra thành `%3A`. Brief viết `/api/providers/<id>/config`; asserted trên đường dẫn THẬT thì phải
 * encode — đây là chỗ một test "đọc brief thay vì đọc source" sẽ đỏ vĩnh viễn.
 */
const configRoute = (id: string): string => `PUT /api/providers/${encodeURIComponent(id)}/config`;

/**
 * Két sắt giả. Renderer chỉ được phép biết HAI sự thật boolean (`configured`, `persistent`) — không
 * con đường nào để test này "nhìn thấy" key, nên `set()` ở đây cũng không trả key lại cho ai.
 */
let vault = new Set<string>();
let persistent = true;
const VAULT_IDS = ['google', 'openai', 'custom:mygateway', 'custom:dup', 'custom:netbay'];

const setSpy = vi.fn();
const deleteSpy = vi.fn();
const statusSpy = vi.fn();

const google: ProviderStatus = { providerId: 'google', configured: false, enabled: true, baseUrl: null, custom: false };
const openai: ProviderStatus = { providerId: 'openai', configured: true, enabled: true, baseUrl: null, custom: false };
// The local DeepSeek bridge row: no provider on this machine ever stores a credential for it, so
// `configured: true` and `keyless: true` come straight from the registry (KEYLESS_PROVIDER_IDS).
const bridgeRow: ProviderStatus = { providerId: 'deepseek-chat', configured: true, enabled: true, baseUrl: null, custom: false, keyless: true };
const gatewayRow: ProviderStatus = {
    providerId: 'custom:mygateway', configured: false, enabled: true, baseUrl: 'https://old.example/v1', custom: true,
};
const dupRow: ProviderStatus = {
    providerId: 'custom:dup', configured: true, enabled: true, baseUrl: 'https://dup.example/v1', custom: true,
};

const mcpStatus: McpStatus = {
    connected: true, studioLinked: false, server: { source: 'none', path: null, version: null },
    studio: null, toolCount: 0, lastError: null, logs: [],
};
const memoryStats: MemoryStats = { projects: 7, sessions: 14, events: 28, approxBytes: 2048 };

function openSettings(tab: SettingsTab, onMemoryCleared?: () => void): void {
    render(<SettingsModal isOpen onClose={() => { /* test này không đo đóng hộp */ }} initialTab={tab} onMemoryCleared={onMemoryCleared} />);
}

beforeEach(() => {
    seen.length = 0;
    order.length = 0;
    handlers.clear();
    vault = new Set<string>();
    persistent = true;

    handlers.set('GET /api/providers', () => json([google, gatewayRow]));
    handlers.set('GET /api/mcp/status', () => json(mcpStatus));
    handlers.set('POST /api/mcp/reconnect', () => json(mcpStatus));
    handlers.set('PUT /api/mcp/path', () => json(mcpStatus));
    handlers.set('GET /api/memory/stats', () => json(memoryStats));
    handlers.set('DELETE /api/memory', () => json({ ok: true, cleared: { projects: 7, sessions: 14, events: 28 } }));
    // The keyless bridge row is not in the default list: only the tests that render it add it, so
    // the other tests never touch `/bridge` (a 404 there would be a fabricated failure).
    handlers.set('GET /api/providers/deepseek-chat/bridge', () => json({ state: 'unreachable', baseUrl: 'http://127.0.0.1:8000/v1' }));

    setSpy.mockReset().mockImplementation(async (providerId: string, apiKey: string) => {
        order.push(`ipc:${providerId}`);
        vault.add(providerId);
        // `apiKey` cố tình KHÔNG được giữ lại: một bridge trả key về renderer là vi phạm bất biến
        // ngay trong test harness, nên ở đây nó chỉ có tác dụng chứng minh tham số được truyền.
        expect(typeof apiKey).toBe('string');
        return { ok: true, persistent };
    });
    deleteSpy.mockReset().mockImplementation(async (providerId: string) => {
        vault.delete(providerId);
        return { ok: true };
    });
    statusSpy.mockReset().mockImplementation(async () => ({
        persistent,
        providers: VAULT_IDS.map((providerId) => ({ providerId, configured: vault.has(providerId) })),
    }));

    // `window.morphi?.credentials` được ĐỌC LÚC RENDER (`SettingsModal.tsx:118`) nên bridge phải có
    // mặt trước khi render; gán lại mỗi test cũng giữ identity ổn định cho `useCallback` của `reload`.
    window.morphi = {
        getToken: async () => 'test-token',
        credentials: { set: setSpy, delete: deleteSpy, status: statusSpy },
    };
});

afterEach(() => {
    cleanup();
    delete window.morphi;
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
});

describe('SettingsModal › mục nào gọi đúng endpoint nấy', () => {
    it('mỗi tab dựng đúng panel của nó và chỉ chạm đúng endpoint của nó', async () => {
        const cases: {
            tab: SettingsTab;
            label: string;
            routes: string[];
            marker: (panel: HTMLElement) => Promise<unknown>;
        }[] = [
            { tab: 'general', label: 'Chung', routes: [], marker: (panel) => within(panel).findByText('Ctrl/⌘ + K') },
            { tab: 'providers', label: 'Nhà cung cấp', routes: ['GET /api/providers'], marker: (panel) => within(panel).findByLabelText('API key cho google') },
            { tab: 'mcp', label: 'MCP', routes: ['GET /api/mcp/status'], marker: (panel) => within(panel).findByText('Trạng thái bridge') },
            { tab: 'memory', label: 'Bộ nhớ', routes: ['GET /api/memory/stats'], marker: (panel) => within(panel).findByText('Dung lượng tệp') },
            { tab: 'advanced', label: 'Nâng cao', routes: [], marker: (panel) => within(panel).findByText('Ngưỡng nén ngữ cảnh') },
        ];

        for (const testCase of cases) {
            cleanup();
            seen.length = 0;
            openSettings(testCase.tab);

            // A1 đo bằng thuộc tính quan hệ, không bằng text tự do: tab được chọn, tabpanel mang id
            // của tab đang chọn, và tab được chọn thì `aria-controls` đúng ô nó điều khiển.
            const tab = screen.getByRole('tab', { name: testCase.label });
            expect(tab, testCase.tab).toHaveAttribute('aria-selected', 'true');
            expect(tab).toHaveAttribute('aria-controls', `settings-panel-${testCase.tab}`);
            const panel = screen.getByRole('tabpanel');
            expect(panel).toHaveAttribute('id', `settings-panel-${testCase.tab}`);
            expect(panel).toHaveAttribute('aria-labelledby', `settings-tab-${testCase.tab}`);
            for (const other of cases.filter((entry) => entry.tab !== testCase.tab)) {
                expect(screen.getByRole('tab', { name: other.label })).toHaveAttribute('aria-selected', 'false');
            }

            await testCase.marker(panel);
            // Chiều có răng nhất: hai mục "không có HTTP" (Chung/Nâng cao) mà gọi route nào là đỏ,
            // và mục có HTTP thì không được gọi DƯ một route nào khác.
            expect(routesOf(), testCase.tab).toEqual(testCase.routes);
            // A10, chiều "thành công thì không gào": load sạch ⇒ không một `role="alert"` nào.
            expect(screen.queryAllByRole('alert'), testCase.tab).toEqual([]);
        }
    });

    it('đổi initialTab khi hộp đang mở thì panel đổi theo, không giữ mục cũ', async () => {
        const view = render(<SettingsModal isOpen onClose={() => {}} initialTab="general" />);
        await screen.findByText('Ctrl/⌘ + K');
        expect(screen.getByRole('tab', { name: 'Chung' })).toHaveAttribute('aria-selected', 'true');

        // Rail "Bộ nhớ" bấm lần hai: cha ĐỔI PROP chứ không remount, nên khối đồng bộ `syncedInitialTab`
        // trong `SettingsModal` (render-time, không phải `useEffect`) là thứ duy nhất khiến người dùng thấy
        // mục vừa chọn chứ không phải mục đang đọc dở. Test phải rerender đúng một hộp — render hai hộp là
        // test một cái khác.
        view.rerender(<SettingsModal isOpen onClose={() => {}} initialTab="memory" />);
        expect(await screen.findByText('Dung lượng tệp')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Bộ nhớ' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Chung' })).toHaveAttribute('aria-selected', 'false');
        // Panel mới nạp số liệu THẬT của nó đúng một lần — không phải một ô nhớ cũ.
        expect(countOf('GET /api/memory/stats')).toBe(1);
    });

    it('bấm chuột vào tab thì panel đổi THẬT: nội dung mới vào, nội dung cũ biến mất', async () => {
        // Nợ M7 (gộp từ `SettingsModal.test.tsx`): vòng lặp per-tab ở trên mở hộp bằng `initialTab`, còn
        // đường người dùng đi thật là CLICK. `onClick={() => setTab(id)}` mất thì mọi assert `aria-selected`
        // vẫn xanh (vì test kia không bấm), nên chiều này phải đo bằng chuột và đo bằng SỰ BIẾN MẤT của
        // panel cũ — một panel swap nửa vời (nội dung cũ vẫn painted dưới) là lỗi mà `getByText` không thấy.
        openSettings('general');
        await screen.findByText('Ctrl/⌘ + K');

        fireEvent.click(screen.getByRole('tab', { name: 'Nâng cao' }));

        expect(screen.getByRole('tab', { name: 'Nâng cao' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Chung' })).toHaveAttribute('aria-selected', 'false');
        expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-advanced');
        expect(await screen.findByText('Model đặt tiêu đề')).toBeInTheDocument();
        expect(screen.queryByText('Ctrl/⌘ + K')).toBeNull();
        // Nâng cao là mục "không có HTTP": bấm vào nó mà phát request nào là panel gọi nhầm endpoint.
        expect(routesOf()).toEqual([]);
    });

    it('mũi tên và Home/End di chuyển selection giữa các mục', async () => {
        openSettings('general');
        await screen.findByText('Ctrl/⌘ + K');
        const list = screen.getByRole('tablist');
        const selected = (): string | null =>
            screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null;
        // m8: selection đổi chưa đủ — FOCUS phải đi theo, nếu không roving tabindex và vòng Tab thực
        // tế lệch nhau (nút vừa nhận `tabIndex=0` vẫn không phải nơi con trỏ đang đứng). Đo
        // `document.activeElement.id` là đo đúng cái người dùng gặp khi bấm Tab tiếp.
        const focusedTab = (): string | null => (document.activeElement as HTMLElement | null)?.id ?? null;

        fireEvent.keyDown(list, { key: 'ArrowDown' });
        expect(selected()).toBe('Nhà cung cấp');
        expect(focusedTab()).toBe('settings-tab-providers');
        // Panel vừa mount có fetch thật: chờ nó settle để không bỏ sót một act nào về sau.
        await screen.findByLabelText('API key cho google');
        fireEvent.keyDown(list, { key: 'ArrowUp' });
        expect(selected()).toBe('Chung');
        expect(focusedTab()).toBe('settings-tab-general');
        // ArrowRight là nhánh OR cùng luật với ArrowDown (`SettingsModal.onTabListKeyDown`); test chỉ ArrowDown
        // thì xoá `|| event.key === 'ArrowRight'` app vẫn xanh — tức phím người dùng bấm thật không có ai canh.
        fireEvent.keyDown(list, { key: 'ArrowRight' });
        expect(selected()).toBe('Nhà cung cấp');
        expect(focusedTab()).toBe('settings-tab-providers');
        await screen.findByLabelText('API key cho google');
        fireEvent.keyDown(list, { key: 'ArrowLeft' });
        expect(selected()).toBe('Chung');
        expect(focusedTab()).toBe('settings-tab-general');
        fireEvent.keyDown(list, { key: 'End' });
        expect(selected()).toBe('Nâng cao');
        expect(focusedTab()).toBe('settings-tab-advanced');
        // Wrap-around: từ cuối đi xuống phải về đầu — một tablist không quay vòng là bẫy bàn phím.
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        expect(selected()).toBe('Chung');
        expect(focusedTab()).toBe('settings-tab-general');
        fireEvent.keyDown(list, { key: 'End' });
        fireEvent.keyDown(list, { key: 'Home' });
        expect(selected()).toBe('Chung');
        expect(focusedTab()).toBe('settings-tab-general');
    });
});

describe('SettingsModal › key không bao giờ ra khỏi két sắt', () => {
    it('két sắt đã có key ⇒ ô key vẫn rỗng, masked, và kiểu input là password', async () => {
        vault.add('google');
        openSettings('providers');
        const keyInput = (await screen.findByLabelText('API key cho google')) as HTMLInputElement;

        // Đo bằng attribute thật chứ không bằng class: `type="text"` + class masked vẫn lộ key.
        expect(keyInput.getAttribute('type')).toBe('password');
        // Client chỉ biết boolean: `configured: true` dịch ra placeholder dots, giá trị vẫn rỗng.
        expect(keyInput.placeholder).toBe('••••••••');
        expect(keyInput.value).toBe('');

        // Ô key của form thêm connector cũng phải là password — cùng một luật, hai chỗ.
        const addKeyInput = screen.getByLabelText('API key cho custom:…') as HTMLInputElement;
        expect(addKeyInput.getAttribute('type')).toBe('password');
        expect(keyLeaks()).toEqual([]);
    });

    it('a keyless provider row shows no key input and explains itself', async () => {
        // Hàng cầu nối DeepSeek chạy cục bộ: đăng nhập bằng session trình duyệt, key bị bỏ qua, nên
        // thẻ không được in ô key — "không có đường nào để nó render lại key đã lưu" (§6.6).
        handlers.set('GET /api/providers', () => json([google, bridgeRow]));
        openSettings('providers');
        await screen.findByText('deepseek-chat');

        expect(screen.queryByLabelText('API key cho deepseek-chat')).toBeNull();
        expect(screen.queryByLabelText('Lưu key deepseek-chat')).toBeNull();
        expect(screen.getByText(/Không cần API key/)).toBeInTheDocument();
        const card = screen.getByText('deepseek-chat').closest('li');
        expect(card).not.toBeNull();
        expect(card).toHaveTextContent('Đã cấu hình');
    });

    it('the keyless row reports the bridge as not running instead of claiming a connection', async () => {
        handlers.set('GET /api/providers', () => json([bridgeRow]));
        openSettings('providers');
        // With no bridge on this machine the row must say so: a "connected" badge with nothing
        // listening on 8000 is the lie this round is about.
        expect(await screen.findByText('Cầu nối chưa chạy.')).toBeInTheDocument();
    });

    it('Ket noi tai khoan posts /connect and keeps the bridge sentence as the feedback', async () => {
        handlers.set('GET /api/providers', () => json([bridgeRow]));
        // The bridge answers 503 login_required: the honest middle state — a window may be open.
        handlers.set('POST /api/providers/deepseek-chat/connect', () => json({
            state: 'login_required',
            baseUrl: 'http://127.0.0.1:8000/v1',
            message: 'Cầu nối đang chạy nhưng không tự mở được cửa sổ đăng nhập. Chạy `python -m deepseek.auth`.',
        }));
        openSettings('providers');
        const button = await screen.findByLabelText('Kết nối tài khoản deepseek-chat');

        fireEvent.click(button);

        await waitFor(() => expect(countOf('POST /api/providers/deepseek-chat/connect')).toBe(1));
        // No credential ever travels: the connect body carries nothing at all.
        expect(bodyOf('POST /api/providers/deepseek-chat/connect')).toBeUndefined();
        // The provider's own instruction is the feedback — not a generic "Đã lưu"/"Thất bại".
        expect(await screen.findByText(/python -m deepseek\.auth/)).toBeInTheDocument();
    });

    it('connect vẫn bấm được khi không có IPC Electron (dev browser): POST /connect đi thẳng tới server', async () => {
        handlers.set('GET /api/providers', () => json([bridgeRow]));
        // Cầu nối sập: câu trả lời trung thực của server là feedback, không phải nút chết trước.
        handlers.set('POST /api/providers/deepseek-chat/connect', () => json({
            state: 'unreachable',
            baseUrl: 'http://127.0.0.1:8000/v1',
            message: 'Không kết nối được tới cầu nối. Chạy `python app.py` trong thư mục Deepseek-API rồi thử lại.',
        }));
        // Không có `window.morphi` = dev browser. Connect là hành động thuần HTTP (server là bên probe
        // cầu nối), nên thiếu két sắt IPC không phải lý do khoá nút — khoá theo IPC đã từng làm nút
        // chết không lời giải thích trong dev browser.
        delete window.morphi;
        openSettings('providers');
        const button = await screen.findByLabelText('Kết nối tài khoản deepseek-chat');
        expect(button).toBeEnabled();

        fireEvent.click(button);

        await waitFor(() => expect(countOf('POST /api/providers/deepseek-chat/connect')).toBe(1));
        expect(await screen.findByText(/python app\.py/)).toBeInTheDocument();
    });

    it('một bấm "Lưu key" = đúng một lời gọi IPC (providerId, SECRET) và HTTP không mang một byte nào', async () => {
        openSettings('providers');
        const keyInput = (await screen.findByLabelText('API key cho google')) as HTMLInputElement;
        // Dán key CÓ hai khoảng trắng thừa: assert `toHaveBeenCalledWith(id, SECRET)` chỉ đỏ khi source
        // thật sự trim (`trimmed` trong `ProviderCard`), chứ không phải khớp ngẫu nhiên.
        fireEvent.change(keyInput, { target: { value: `  ${SECRET}  ` } });
        fireEvent.click(screen.getByRole('button', { name: 'Lưu key google' }));

        await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
        expect(setSpy).toHaveBeenCalledWith('google', SECRET);

        // Phép đo an ninh thật: DUYỆT mọi request đã phát, cả URL lẫn body (body là JSON thô),
        // không một mẩu nào chứa key. Không phải "set được gọi" — cái đó đứng được dù HTTP có rò rỉ.
        for (const entry of seen) {
            expect(entry.route).not.toContain(SECRET);
        }
        expect(bodiesOf().filter((body) => body.includes(SECRET))).toEqual([]);
        // Lưu key không đụng route config nào (`api.providers.*` chỉ chạm `/config` khi ghi baseUrl).
        expect(writesOf('PUT')).toEqual([]);
        // Transport thật còn sống ⇒ header token có nghĩa (và chứng minh test không mock `lib/api`).
        const headers = new Headers(seen[0]?.init?.headers);
        expect(headers.get('X-Morphi-Token')).toBe('test-token');
        expect(headers.get('Authorization')).toBeNull();

        // Key phải biến khỏi DOM ngay sau khi trao cho bridge.
        await waitFor(() => expect(keyInput.value).toBe(''));
        expect(keyLeaks()).toEqual([]);
        expect(screen.getByRole('status')).toHaveTextContent(/Đã lưu\./);
    });

    it('key KHÔNG theo khuôn sk-… cũng không được in ra DOM (bất biến không phụ thuộc hình key)', async () => {
        // KEY_SHAPE chỉ bắt `sk-…`, nên một key Gemini thật (`AIza…`) lọt qua sweep hình. Phép thử ở đây
        // là LITERAL — cùng hai kênh như test trên (không vào HTTP, không vào DOM) nhưng so bằng đúng
        // chuỗi đã dán, vì "không key nào vào DOM" là bất biến về HÀNH VI, không về mẫu chuỗi.
        const ODD = 'AIzaSyD-abcdefghijklmnopqrstuvwx1234567';
        openSettings('providers');
        const keyInput = (await screen.findByLabelText('API key cho google')) as HTMLInputElement;
        fireEvent.change(keyInput, { target: { value: ODD } });
        // ĐO LÚC ĐANG DÁN, không chỉ sau khi ghi: `setDraft('')` làm sạch value ngay sau nút Lưu, nên một
        // assert sau submit xanh kể cả khi component in `draft` ra placeholder/chữ. Đây là lúc duy nhất
        // key CÓ MẶT trong component, và nó chỉ được phép nằm ở đúng một chỗ: value của ô password —
        // `strippedHtml` gỡ mirror `value` nên nếu key hiện ra ở CHỮ hay thuộc tính khác thì đỏ ngay.
        expect(keyInput.value).toBe(ODD);
        expect(keyInput.getAttribute('type')).toBe('password');
        expect(keyLeaks([ODD])).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: 'Lưu key google' }));

        await waitFor(() => expect(setSpy).toHaveBeenCalledWith('google', ODD));
        expect(bodiesOf().filter((body) => body.includes(ODD))).toEqual([]);
        await waitFor(() => expect(keyInput.value).toBe(''));
        expect(keyLeaks([ODD])).toEqual([]);
    });

    it('xoá key = một lời gọi IPC delete, rồi nạp lại cả danh sách harness lẫn két sắt', async () => {
        vault.add('google');
        openSettings('providers');
        const deleteButton = await screen.findByRole('button', { name: 'Xoá key google' });
        expect(countOf('GET /api/providers')).toBe(1);
        expect(statusSpy).toHaveBeenCalledTimes(1);

        fireEvent.click(deleteButton);

        await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
        expect(deleteSpy).toHaveBeenCalledWith('google');
        // "Nguồn trạng thái là két sắt" chỉ kiểm chứng được bằng refetch: đúng một GET nữa, và
        // `credentials.status()` được hỏi lại lần hai — không có DELETE HTTP nào.
        await waitFor(() => expect(countOf('GET /api/providers')).toBe(2));
        expect(statusSpy).toHaveBeenCalledTimes(2);
        expect(writesOf('DELETE')).toEqual([]);
        // Và DOM nói theo két sắt: nút xoá biến mất vì không còn key nào được báo có.
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Xoá key google' })).toBeNull());
    });

    it('nhãn thẻ suy ra từ HAI bit: harness giữ key thì "Đã cấu hình", két sắt giữ mà harness không thì "Lỗi"', async () => {
        // Ba thẻ, ba tổ hợp bit — mỗi cái một nhánh của `stateOf`, nên đảo một nhánh là đỏ tại chỗ đó.
        handlers.set('GET /api/providers', () => json([openai, google, gatewayRow]));
        vault.add('google');
        openSettings('providers');

        const cardOf = async (providerId: string): Promise<HTMLElement> => {
            const title = await screen.findByText(providerId);
            const card = title.closest('li');
            expect(card, providerId).not.toBeNull();
            return card as HTMLElement;
        };

        expect(within(await cardOf('openai')).getByText('Đã cấu hình')).toBeInTheDocument();
        expect(within(await cardOf('google')).getByText('Lỗi')).toBeInTheDocument();
        expect(within(await cardOf('google')).getByText(/Key đã nằm trong két sắt nhưng harness chưa nhận/)).toBeInTheDocument();
        expect(within(await cardOf('custom:mygateway')).getByText('Chưa cấu hình')).toBeInTheDocument();
        // Không thẻ nào in key: hai bit boolean là tất cả những client biết, nên ở đây cái được canh
        // là MỌI chuỗi hình-key, không phải một xâu cụ thể chưa từng đi vào DOM.
        expect(keyLeaks()).toEqual([]);
    });

    it('renders a brand logo for each provider card', async () => {
        handlers.set('GET /api/providers', () => json([google, openai]));
        openSettings('providers');

        expect(await screen.findByRole('img', { name: 'google' })).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'openai' })).toBeInTheDocument();
    });

    it('an toàn theo cả hai chiều: safeStorage từ chối thì cảnh báo, mở được thì im', async () => {
        persistent = false;
        openSettings('providers');
        expect(await screen.findByText(/Hệ thống không mở được safeStorage/)).toBeInTheDocument();

        // Chiều ngược lại mới là chỗ một cảnh báo "luôn bật" bị bắt: bỏ một trong hai chiều thì assert
        // chỉ còn là một nửa sự thật.
        cleanup();
        persistent = true;
        openSettings('providers');
        await screen.findByLabelText('API key cho google');
        expect(screen.queryByText(/Hệ thống không mở được safeStorage/)).toBeNull();
    });
});

describe('SettingsModal › ghi thật sự đi qua HTTP nào', () => {
    it('lưu base URL của connector = PUT /api/providers/custom%3Amygateway/config với đúng body source gửi', async () => {
        handlers.set(configRoute('custom:mygateway'), () => json({ ...gatewayRow, baseUrl: 'https://new.example/v1' }));
        openSettings('providers');
        const urlInput = (await screen.findByLabelText('Base URL cho custom:mygateway')) as HTMLInputElement;
        fireEvent.change(urlInput, { target: { value: ' https://new.example/v1 ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Lưu base URL' }));

        await waitFor(() => expect(countOf(configRoute('custom:mygateway'))).toBe(1));
        // Body THẬT là `{ baseUrl }` đã trim — KHÔNG có `enabled: true` như brief đoán ở A6, và cũng
        // không có key. `toEqual` (không phải `toMatchObject`) mới chặn cả hai loại thừa.
        expect(bodyOf(configRoute('custom:mygateway'))).toEqual({ baseUrl: 'https://new.example/v1' });
        expect(setSpy).not.toHaveBeenCalled();
        expect(screen.getByRole('status')).toHaveTextContent(/Đã lưu\./);
    });

    it('một bấm "Thêm connector" ghi config lên HTTP TRƯỚC rồi mới nạp key qua IPC — key không lên HTTP', async () => {
        handlers.set(configRoute('custom:netbay'), () => {
            order.push('http:custom:netbay');
            return json({ ...dupRow, providerId: 'custom:netbay' });
        });
        openSettings('providers');

        fireEvent.change(await screen.findByLabelText('Tên viết tắt (slug)'), { target: { value: 'netbay' } });
        fireEvent.change(screen.getByLabelText('Base URL cho custom:netbay'), { target: { value: 'https://gw.example/v1' } });
        fireEvent.change(screen.getByLabelText('API key cho custom:netbay'), { target: { value: SECRET } });
        fireEvent.click(screen.getByRole('button', { name: 'Thêm connector' }));

        await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
        expect(bodyOf(configRoute('custom:netbay'))).toEqual({ baseUrl: 'https://gw.example/v1', enabled: true });
        expect(setSpy).toHaveBeenCalledWith('custom:netbay', SECRET);
        // Thứ tự là hợp đồng (`routes/providers.ts` dựng hàng + endpoint trước, IPC ghi key sau):
        // đảo hai dòng là connector nhận key mà chưa có chỗ nào để đọc nó.
        expect(order).toEqual(['http:custom:netbay', 'ipc:custom:netbay']);
        expect(bodiesOf().filter((body) => body.includes(SECRET))).toEqual([]);
    });

    it('slug trống hoặc trùng tên ⇒ form không gửi gì cả, không PUT không IPC', async () => {
        handlers.set('GET /api/providers', () => json([google, dupRow]));
        handlers.set(configRoute('custom:'), () => json(google));
        handlers.set(configRoute('custom:dup'), () => json(dupRow));
        openSettings('providers');

        // Panel còn `loading` cho tới khi `GET /api/providers` về: mọi query phải SAU cái chờ đó.
        const slugInput = await screen.findByLabelText('Tên viết tắt (slug)');
        const submit = screen.getByRole('button', { name: 'Thêm connector' });

        // Base URL + key hợp lệ nhưng slug rỗng: id sẽ là `custom:` (tức một hàng rác trên server),
        // nên nút PHẢI chết. Nhãn ô tra theo slug hiện tại là `custom:…`.
        fireEvent.change(screen.getByLabelText('Base URL cho custom:…'), { target: { value: 'https://gw.example/v1' } });
        fireEvent.change(screen.getByLabelText('API key cho custom:…'), { target: { value: SECRET } });
        expect(submit).toBeDisabled();
        fireEvent.click(submit);
        expect(writesOf('PUT')).toEqual([]);
        expect(setSpy).not.toHaveBeenCalled();

        // Slug trùng một hàng đã có: cùng một luật "không gửi gì", nhưng bằng một cơ chế khác.
        fireEvent.change(slugInput, { target: { value: 'dup' } });
        expect(await screen.findByText('Connector này đã tồn tại.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Thêm connector' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Thêm connector' }));
        expect(writesOf('PUT')).toEqual([]);
        expect(setSpy).not.toHaveBeenCalled();
    });

    it('xoá dữ liệu = đúng một DELETE /api/memory không body, và phiên đang mở được báo reset', async () => {
        const onMemoryCleared = vi.fn();
        openSettings('memory', onMemoryCleared);
        expect(await screen.findByText('7')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Xoá dữ liệu' }));
        expect(await screen.findByText('Toàn bộ dự án, cuộc trò chuyện và sự kiện sẽ bị xoá. Không thể hoàn tác.'))
            .toBeInTheDocument();
        // Hộp xác nhận chưa phải là lệnh xoá: HTTP vẫn im lặng.
        expect(countOf('DELETE /api/memory')).toBe(0);

        const confirmButtons = screen.getAllByRole('button', { name: 'Xoá dữ liệu' });
        fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);

        await waitFor(() => expect(countOf('DELETE /api/memory')).toBe(1));
        // `del()` của lib/api là request không body — pin điều đó, vì một body `{}` dôi ra là một
        // contract khác với server.
        const entry = seen.find((item) => item.route === 'DELETE /api/memory');
        expect(entry?.init?.body).toBeUndefined();
        expect(screen.getByRole('status')).toHaveTextContent(/Đã xoá bộ nhớ\./);
        // Số liệu đã xoá thì không còn để in: bốn thẻ về dấu gạch ngang, và cha nhận đúng một callback.
        expect(screen.getAllByText('—')).toHaveLength(4);
        expect(onMemoryCleared).toHaveBeenCalledTimes(1);
    });

    it('lần tải provider thất bại không bỏ panel treo ở trạng thái loading', async () => {
        handlers.set('GET /api/providers', () => json({ error: { code: 'INTERNAL_ERROR' } }, 500));
        const { container } = render(<SettingsModal isOpen onClose={() => {}} initialTab="providers" />);

        // Hợp đồng M1 mà round 1 đã dựng trong source: một lần tải provider hỏng phải (a) THOÁT loading
        // — nhãn `providersLoading` biến mất, (b) nói thẳng lỗi trong một live region cấp panel
        // (`SettingsModal.tsx:181-190`, `role="alert"` + `aria-live="assertive"`), và (c) GATE form thêm
        // connector (`SettingsModal.tsx:229`): `existingIds` rỗng thì không phát hiện được trùng và không
        // thẻ nào hiển thị trạng thái của key vừa dán, nên "Thêm" sẽ ghi mù — §6.6.2 cấm nút kiểu đó.
        // Copy assert lấy nguyên văn từ `errorCopy.ts:27` cho code `INTERNAL_ERROR` mà handler ở dòng trên
        // trả về: đổi code→copy hoặc bỏ alert là đỏ, đây không phải một literal tự bịa "cho đẹp".
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/Server harness gặp lỗi nội bộ\./);
        expect(screen.queryByText(/Đang đọc danh sách nhà cung cấp/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Thêm connector' })).toBeNull();
        expect(container.querySelectorAll('li')).toHaveLength(0);
        expect(countOf('GET /api/providers')).toBe(1);
        // Và két sắt không bị hỏi khi danh sách chưa về (`reload` bail ngay sau `api.providers.list`).
        expect(statusSpy).not.toHaveBeenCalled();
    });

    it('chiều ngược lại (M1): tải provider THÀNH CÔNG thì không có alert và form còn sống', async () => {
        // Test lỗi-only một chiều không chứng minh được gì: một bản dựng alert VÔ ĐIỀU KIỆN (kể cả khi
        // fetch thành công) vẫn xanh. Nợ M1 round 2 là đúng chiều này — success thì panel phải là UI bình
        // thường: không live region cấp lỗi, danh sách in ra, và form "Thêm connector" tồn tại.
        openSettings('providers');
        await screen.findByText('google');

        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText(/Đang đọc danh sách nhà cung cấp/)).toBeNull();
        // `disabled` ở đây chỉ vì form còn thiếu dữ liệu (`ProviderCard.valid` = slug + URL http(s) + key),
        // không phải vì danh sách chết ⇒ điền đủ ba ô là nút bật. Đó là khác biệt giữa "form bị gate vì
        // list lỗi" (test ở trên) và "form bình thường đang chờ người dùng gõ" (test này).
        // Slug chọn tên KHÔNG trùng với danh sách mặc định của file (`custom:mygateway` đã có sẵn một thẻ,
        // nên dùng tên đó sẽ thành "multiple elements" chứ không phải bug của app).
        const addButton = screen.getByRole('button', { name: 'Thêm connector' });
        fireEvent.change(screen.getByLabelText('Tên viết tắt (slug)'), { target: { value: 'probegw' } });
        fireEvent.change(screen.getByLabelText('Base URL cho custom:probegw'), { target: { value: 'https://gw.example/v1' } });
        fireEvent.change(screen.getByLabelText('API key cho custom:probegw'), { target: { value: 'sk-probe-12345' } });
        expect(addButton).toBeEnabled();
        expect(countOf('GET /api/providers')).toBe(1);
    });
});

describe('SettingsModal › chỉ đọc và alert', () => {
    it('mục Nâng cao không có lấy một control sửa được', async () => {
        openSettings('advanced');
        const panel = screen.getByRole('tabpanel');
        await within(panel).findByText('Ngưỡng nén ngữ cảnh');

        // Chặn hồi quy "thêm ô sửa giả": một input nào đó trong hộp (kể cả ngoài panel) là đỏ.
        expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0);
        // `button` phải đếm RIÊNG trong panel: cả hộp thì luôn có tab button, còn một nút "Lưu" nằm
        // trong panel Nâng cao là đúng cái chết §6.6.2 cấm — nút bấm rồi không làm gì.
        expect(within(panel).queryAllByRole('button')).toHaveLength(0);
        for (const label of ['Model đặt tiêu đề', 'Thứ tự ưu tiên khi tự chọn model', 'Ngưỡng nén ngữ cảnh']) {
            expect(within(panel).getByText(label)).toBeInTheDocument();
        }
        expect(within(panel).getAllByText('Chỉ đọc')).toHaveLength(3);
        // Không chỉ im lặng mà sửa: panel phải NÓI lý do không có ô sửa, nếu người dùng đi tìm nó.
        expect(within(panel).getByText(/không sửa trong UI/)).toBeInTheDocument();
    });

    it('route MCP fail ngay lần tải đầu ⇒ role="alert" nói theo code, không có số liệu bịa', async () => {
        handlers.set('GET /api/mcp/status', () => json({ error: { code: 'INTERNAL_ERROR' } }, 500));
        openSettings('mcp');

        // envelope → `ApiError.code` → `errorCopy` chạy TRÊN ĐƯỜNG DÂY THẬT: một 500 `{error:{code}}`
        // không bao giờ được biến thành text thô của server, và cũng không được im lặng.
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/Server harness gặp lỗi nội bộ\./);
        // Không một dòng trạng thái nào được vẽ khi chưa có `McpStatus`: hết "connected" màu xanh,
        // hết bảng số liệu — đó chính là điều §6.6.2 cấm.
        expect(screen.queryByText('Đã kết nối')).toBeNull();
        expect(screen.queryByText('Chưa kết nối')).toBeNull();
        expect(screen.queryByText('Trạng thái bridge')).toBeNull();
    });

    it('kết nối lại thất bại ⇒ alert theo code mới mà số liệu cũ còn nguyên, rồi thành công ⇒ alert tắt', async () => {
        handlers.set('GET /api/mcp/status', () => json({ ...mcpStatus, studioLinked: true }));
        handlers.set('POST /api/mcp/reconnect', () => json({ error: { code: 'NO_PROVIDER' } }, 400));
        openSettings('mcp');
        await screen.findByText('Đã kết nối');
        // A10 chiều sạch: load thành công thì không có alert nào được dựng sẵn.
        expect(screen.queryAllByRole('alert')).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: 'Kết nối lại' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/Chưa cấu hình provider nào/);
        // Server chưa đổi gì thì client không được phép "đoán" một trạng thái mới: bảng số liệu cũ
        // vẫn còn, vì `status` chỉ bị ghi đè khi action thành công.
        expect(screen.getByText('Đã kết nối')).toBeInTheDocument();
        expect(screen.getByText('Chưa phát hiện đường dẫn thực thi.')).toBeInTheDocument();

        // Chiều có răng nhất của A10: một lần ghi thành công phải TẮT được lời đang gào. Nếu source
        // bỏ `setError(null)` (`McpPanel.tsx:52`) thì alert sống dai dù bridge đã nối lại.
        handlers.set('POST /api/mcp/reconnect', () => json({ ...mcpStatus, studioLinked: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Kết nối lại' }));
        await waitFor(() => expect(screen.queryAllByRole('alert')).toEqual([]));
        expect(screen.getByText('Đã kết nối')).toBeInTheDocument();
        expect(countOf('POST /api/mcp/reconnect')).toBe(2);
    });

    it('xoá dữ liệu thất bại ⇒ alert theo code, số liệu còn nguyên và cha không nhận callback reset', async () => {
        const onMemoryCleared = vi.fn();
        handlers.set('DELETE /api/memory', () => json({ error: { code: 'INTERNAL_ERROR' } }, 500));
        openSettings('memory', onMemoryCleared);
        await screen.findByText('7');

        fireEvent.click(screen.getByRole('button', { name: 'Xoá dữ liệu' }));
        const confirmButtons = await screen.findAllByRole('button', { name: 'Xoá dữ liệu' });
        fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);

        expect(await screen.findByRole('alert')).toHaveTextContent(/Server harness gặp lỗi nội bộ\./);
        // Không có "Đã xoá" màu xanh khi server từ chối — và transcript không bị vứt oan.
        expect(screen.queryByText('Đã xoá bộ nhớ.')).toBeNull();
        expect(screen.getByText('7')).toBeInTheDocument();
        expect(onMemoryCleared).not.toHaveBeenCalled();
    });
});
