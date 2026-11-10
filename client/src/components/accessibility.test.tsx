import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

/**
 * Surface a11y của Task 24: bẫy focus, semantic dialog, nhãn cho nút icon-only, vùng trạng thái,
 * và rule responsive. Task này CHỈ assert được những gì jsdom quan sát được; theo Phán quyết P20-2, sweep
 * 1440/1024/768/375 THUỘC TASK 25 (Playwright), không phải ở đây — nên file này kiểm điều kiện
 * CSS/`matchMedia` và KHÔNG tuyên bố đã pass visual.
 *
 * Mock `api` qua `vi.mock` + `importOriginal` để giữ `ApiError`/`codeOf` THẬT; chỉ thay các hàm transport.
 */
const mockFns = vi.hoisted(() => ({
    list: vi.fn(),
    updateConfig: vi.fn(),
    mcpStatus: vi.fn(),
    mcpReconnect: vi.fn(),
    mcpSetPath: vi.fn(),
    memoryStats: vi.fn(),
    memoryClear: vi.fn(),
    toolsList: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        api: {
            ...actual.api,
            providers: { list: mockFns.list, updateConfig: mockFns.updateConfig },
            mcp: { status: mockFns.mcpStatus, reconnect: mockFns.mcpReconnect, setPath: mockFns.mcpSetPath },
            memory: { stats: mockFns.memoryStats, clear: mockFns.memoryClear },
            tools: { ...actual.api.tools, list: mockFns.toolsList },
        },
    };
});

import { SettingsModal } from './settings/SettingsModal';
import { ConfirmModal } from './ConfirmModal';
import { CreateProjectModal } from './CreateProjectModal';
import { Header } from './layout/Header';
import { AppShell, DESKTOP_QUERY } from './layout/AppShell';
import { Composer } from './chat/Composer';

// Selector y hệt `FOCUSABLE` trong `useFocusTrap.ts` — test phải đi theo đúng danh sách phần tử mà trap dùng.
const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const insideDialog = (): HTMLElement => screen.getByRole('dialog');

const focusablesIn = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && !el.hasAttribute('disabled'),
    );

/** Nút không có chữ nào (chỉ svg) — tập hợp mà phép quét tên truy cập THỰC sự soi. Đếm nó để một cây
 *  rỗng không tự pass: vòng quét không thấy gì thì `toEqual([])` xanh mà chẳng chứng minh điều gì. */
const iconOnlyButtons = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter((button) => !(button.textContent ?? '').trim());

/**
 * Nút chỉ có icon PHẢI có `aria-label` không rỗng. m9: `title` bị LOẠI, dù accname vẫn coi title là tên
 * cuối dãy — lý do thật là luật của §6.6.2/B3 nhân danh control, còn `title` chỉ là tooltip cho chuột;
 * chấp nhận title-only nghĩa là một thuộc tính hover trá hình được tên. Trong tree này MỌI `title` của
 * button đều đã đi kèm `aria-label` (đo bằng grep trước khi sửa), nên bỏ nhánh title không bắt thêm
 * control nào — nó chỉ làm phép quét đủ chặt để đỏ khi ai đó bỏ `aria-label` mà để lại mỗi tooltip.
 */
const unnamedIconButtons = (root: HTMLElement): string[] =>
    Array.from(root.querySelectorAll('button'))
        .filter((button) => (button.textContent ?? '').trim().length === 0)
        .filter((button) => (button.getAttribute('aria-label') ?? '').trim() === '')
        .map((button) => button.outerHTML.slice(0, 80));

function makeMatchMedia(matchesFor: (query: string) => boolean) {
    return vi.fn((query: string) => ({
        matches: matchesFor(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
    // Mặc định: desktop query ĐÚNG, còn OS dark và reduced-motion SAI — mỗi test override nếu cần.
    window.matchMedia = makeMatchMedia((q) => q === DESKTOP_QUERY);
    mockFns.list.mockReset().mockResolvedValue([]);
    mockFns.updateConfig.mockReset().mockResolvedValue({});
    mockFns.mcpStatus.mockReset().mockResolvedValue({ connected: false, studioLinked: false, server: { source: 'none', path: null, version: null }, logs: [] });
    mockFns.mcpReconnect.mockReset().mockResolvedValue({ connected: false, studioLinked: false, server: { source: 'none', path: null, version: null }, logs: [] });
    mockFns.mcpSetPath.mockReset().mockResolvedValue({ connected: false, studioLinked: false, server: { source: 'none', path: null, version: null }, logs: [] });
    mockFns.memoryStats.mockReset().mockResolvedValue({ projects: 0, sessions: 0, events: 0, approxBytes: 0 });
    mockFns.memoryClear.mockReset().mockResolvedValue({ ok: true, cleared: { projects: 0, sessions: 0, events: 0 } });
    mockFns.toolsList.mockReset().mockResolvedValue([]);
    window.morphi = {
        getToken: async () => 'test-token',
        credentials: { set: vi.fn().mockResolvedValue({ ok: true }), delete: vi.fn().mockResolvedValue({ ok: true }), status: vi.fn().mockResolvedValue({ persistent: true, providers: [] }) },
    };
});

afterEach(() => {
    cleanup();
    delete window.morphi;
    localStorage.clear();
    document.documentElement.classList.remove('dark');
});

describe('SettingsModal focus trap', () => {
    it('moves focus into the dialog when it opens', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        await waitFor(() => expect(insideDialog()).toBeInTheDocument());
        expect(insideDialog().contains(document.activeElement)).toBe(true);
    });

    it('wraps Tab forward from the last control back to the first', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        await waitFor(() => expect(insideDialog()).toBeInTheDocument());

        const items = focusablesIn(insideDialog());
        const last = items[items.length - 1];
        const first = items[0];
        last.focus();
        fireEvent.keyDown(last, { key: 'Tab' });

        // Không thoát ra ngoài dialog: focus nhảy về phần tử ĐẦU thay vì trượt sang trang.
        expect(document.activeElement).toBe(first);
        expect(insideDialog().contains(document.activeElement)).toBe(true);
    });

    it('wraps Shift+Tab backward from the first control to the last', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        await waitFor(() => expect(insideDialog()).toBeInTheDocument());

        const items = focusablesIn(insideDialog());
        const first = items[0];
        const last = items[items.length - 1];
        first.focus();
        fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });

        expect(document.activeElement).toBe(last);
        expect(insideDialog().contains(document.activeElement)).toBe(true);
    });

    it('closes on Escape through onClose', async () => {
        const onClose = vi.fn();
        render(<SettingsModal isOpen onClose={onClose} initialTab="providers" />);
        await waitFor(() => expect(insideDialog()).toBeInTheDocument());

        fireEvent.keyDown(insideDialog(), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('returns focus to the element that opened it once closed', async () => {
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>mo-cua-so</button>
                    <SettingsModal isOpen={open} onClose={() => setOpen(false)} initialTab="providers" />
                </>
            );
        }
        render(<Harness />);

        const opener = screen.getByRole('button', { name: 'mo-cua-so' });
        opener.focus();
        fireEvent.click(opener);
        await waitFor(() => expect(insideDialog()).toBeInTheDocument());
        expect(insideDialog().contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(insideDialog(), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(opener);
    });
});

describe('overlay ngoài stack giữ được phím của chính nó (m-trap, Task 24 round 2)', () => {
    /**
     * Overlay giả dựng đúng hình dạng thứ mà `useFocusTrap` từng nuốt phím: `role="dialog"` +
     * `aria-modal="true"` (`SearchPalette.tsx:153-154`, `ApprovalModal.tsx:110-111`) và TỰ xử Escape bằng
     * handler của riêng nó ở bubble phase (`SearchPalette.tsx:104-108`, `ApprovalModal.tsx:98`) — tức KHÔNG
     * đăng ký vào `activeTraps`. Gắn node vào `container` của RTL để `cleanup()` dọn giúp; append thẳng vào
     * `document.body` sẽ sống sót sang test kế tiếp.
     */
    const mountOverlay = (container: HTMLElement) => {
        let closed = 0;
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Bảng tìm kiếm');
        const input = document.createElement('input');
        input.setAttribute('aria-label', 'O-ver-lay');
        overlay.appendChild(input);
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closed += 1;
                overlay.remove();
            }
        });
        container.appendChild(overlay);
        return { overlay, input, closedCount: () => closed };
    };

    it('Escape đóng overlay, không đóng Settings đang mở bên dưới', async () => {
        const onClose = vi.fn();
        function Harness() {
            const [open, setOpen] = useState(true);
            return (
                <SettingsModal
                    isOpen={open}
                    onClose={() => {
                        setOpen(false);
                        onClose();
                    }}
                    initialTab="providers"
                />
            );
        }
        const { container } = render(<Harness />);
        const settings = await waitFor(() => screen.getByRole('dialog', { name: 'Cài đặt' }));

        const overlay = mountOverlay(container);
        overlay.input.focus();
        expect(overlay.input).toHaveFocus();
        fireEvent.keyDown(overlay.input, { key: 'Escape' });

        // Hậu quả (i) của re-review §2.4 là "một phím Esc đóng Settings thay vì palette". Hai vế dưới đây bắt
        // đúng hai nửa: overlay PHẢI nhận được phím (nó mới đóng), và Settings KHÔNG được đóng.
        expect(overlay.closedCount()).toBe(1);
        expect(document.body.contains(overlay.overlay)).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Cài đặt' })).toBe(settings);
        expect(settings).toBeInTheDocument();
    });

    it('Tab trong overlay không bị bẫy focus của Settings kéo về dialog', async () => {
        const { container } = render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        const settings = await waitFor(() => screen.getByRole('dialog', { name: 'Cài đặt' }));

        const overlay = mountOverlay(container);
        overlay.input.focus();
        // `fireEvent` trả `false` nếu handler nào đó gọi `preventDefault()` — ở đây nó là bằng chứng trap đã
        // im lặng toàn phần chứ không "cho qua rồi vẫn cắt phím".
        const notPrevented = fireEvent.keyDown(overlay.input, { key: 'Tab' });

        // Hậu quả (ii): trước round 2, `!container.contains(current)` của Settings kéo focus về dialog của nó.
        expect(notPrevented).toBe(true);
        expect(document.activeElement).toBe(overlay.input);
        expect(settings.contains(document.activeElement)).toBe(false);
    });

    it('dialog ĐÃ đăng ký trong stack vẫn giữ luật cũ: Escape của overlay lồng không bị mất', async () => {
        // Control ngược chiều, để nhánh return mới không trở thành "trap mặc nhận mọi overlay": ConfirmModal
        // là overlay `role=dialog aria-modal` CÓ đăng ký (`ConfirmModal.tsx:45`) nên nó vẫn là đỉnh stack và
        // vẫn ăn Escape của chính nó, Settings không đóng kèm (Ruling M3-a).
        const onSettingsClose = vi.fn();
        const onConfirmClose = vi.fn();
        render(
            <>
                <SettingsModal isOpen onClose={onSettingsClose} initialTab="memory" />
                <ConfirmModal
                    isOpen
                    onClose={onConfirmClose}
                    onConfirm={() => {}}
                    title="Xoá toàn bộ bộ nhớ?"
                    message="Không thể hoàn tác."
                />
            </>,
        );
        const dialogs = await waitFor(() => screen.getAllByRole('dialog'));
        expect(dialogs).toHaveLength(2);

        const confirmDialog = screen.getByRole('dialog', { name: 'Xoá toàn bộ bộ nhớ?' });
        fireEvent.keyDown(confirmDialog, { key: 'Escape' });
        expect(onConfirmClose).toHaveBeenCalledTimes(1);
        expect(onSettingsClose).not.toHaveBeenCalled();
    });
});

describe('dialog lồng NHAU THẬT: Settings / Bộ nhớ / hộp xác nhận xoá (nợ M3)', () => {
    // Nút xoá trong MemoryPanel là đường đi THẬT duy nhất của app tới một ConfirmModal lồng trong dialog
    // khác. Fixture mountOverlay ở describe trên chỉ giả lập overlay CHƯA đăng ký; ở đây cả hai hộp đều
    // đăng ký vào activeTraps, nên phép thử này soi đúng bốn điều re-review hỏi: số hộp, focus, một phím
    // Escape, và vị trí DOM của hộp lồng.
    const openNestedConfirm = async () => {
        const onSettingsClose = vi.fn();
        render(<SettingsModal isOpen onClose={onSettingsClose} initialTab="memory" />);
        const settings = await waitFor(() => screen.getByRole('dialog', { name: 'Cài đặt' }));
        // Panel vẽ trạng thái loading tới khi GET /api/memory/stats resolve, nên nút xoá chưa tồn tại.
        const clearButton = await waitFor(() => screen.getByRole('button', { name: 'Xoá dữ liệu' }));
        fireEvent.click(clearButton);
        const confirm = await waitFor(() => screen.getByRole('dialog', { name: 'Xoá dữ liệu' }));
        return { settings, confirm, onSettingsClose };
    };

    it('(a) hộp xác nhận mở từ panel trở thành hộp dialog THỨ HAI trong DOM', async () => {
        await openNestedConfirm();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
        expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(2);
    });

    it('(b) focus rơi vào hộp lồng, không ở lại Settings', async () => {
        const { settings, confirm } = await openNestedConfirm();
        expect(confirm.contains(document.activeElement)).toBe(true);
        expect(settings.contains(document.activeElement)).toBe(false);
    });

    it('(c) một phím Escape chỉ đóng hộp lồng, Settings vẫn còn trong DOM', async () => {
        const { settings, confirm, onSettingsClose } = await openNestedConfirm();
        // Bắn phím từ node đang focus (đường đi thật của phím), không phải từ confirm.
        fireEvent.keyDown(document.activeElement ?? confirm, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Xoá dữ liệu' })).toBeNull());
        expect(screen.getByRole('dialog', { name: 'Cài đặt' })).toBe(settings);
        expect(onSettingsClose).not.toHaveBeenCalled();
    });

    it('(d) control của hộp lồng không nằm trong danh sách focusable của Settings', async () => {
        const { settings, confirm } = await openNestedConfirm();
        // Anti-vacuity: hộp lồng phải có control để đếm, nếu không assert dưới xanh vì cây rỗng.
        const confirmItems = focusablesIn(confirm);
        expect(confirmItems.length).toBeGreaterThan(0);
        // Tính chất này do createPortal(..., document.body) tạo ra: thiếu portal thì confirm là con của
        // settings và mọi nút của nó lọt vào danh sách của settings, tức test ĐỎ.
        expect(settings.contains(confirm)).toBe(false);
        const settingsItems = focusablesIn(settings);
        expect(confirmItems.filter((el) => settingsItems.includes(el))).toEqual([]);
    });
});

describe('M4 - nhánh focus-ra-khỏi-container của trap là nhánh SỐNG', () => {
    // useFocusTrap có nhánh "focus nằm ngoài container" để kéo nó về dialog khi AT (hoặc một lần blur lập
    // trình) đặt con trỏ ra nền. Trước round 3 không test nào chạm tới: mọi test Tab đều bắt đầu từ một phần
    // tử BÊN TRONG dialog nên container.contains(current) luôn đúng, tức xoá cả nhánh app vẫn xanh.
    const blurToBody = () => {
        (document.activeElement as HTMLElement | null)?.blur();
        document.body.focus();
    };

    it('Tab khi activeElement nằm ngoài dialog bị kéo VỀ control đầu tiên', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        const dialog = await waitFor(() => insideDialog());
        const items = focusablesIn(dialog);
        expect(items.length).toBeGreaterThan(0);

        blurToBody();
        expect(dialog.contains(document.activeElement)).toBe(false);

        // fireEvent trả false khi có handler gọi preventDefault: bằng chứng nhánh M4 chạy chứ không phải
        // "Tab lọt qua rồi tình cờ focus vẫn còn trong dialog".
        expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
        expect(document.activeElement).toBe(items[0]);
        expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('Shift+Tab khi activeElement nằm ngoài dialog bị kéo VỀ control cuối', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        const dialog = await waitFor(() => insideDialog());
        const items = focusablesIn(dialog);

        blurToBody();
        expect(dialog.contains(document.activeElement)).toBe(false);

        expect(fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(items[items.length - 1]);
    });
});

describe('dialog semantics', () => {
    it('exposes Settings as a labelled modal dialog', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        const dialog = await waitFor(() => insideDialog());
        expect(dialog).toHaveAttribute('role', 'dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        // Dialog này nhãn bằng `aria-label` (khác CreateProjectModal dùng `aria-labelledby`); tên truy cập
        // khớp đúng heading `h2` bên trong nó.
        expect(dialog).toHaveAccessibleName('Cài đặt');
        expect(screen.getByRole('heading', { name: 'Cài đặt' })).toBeInTheDocument();
    });

    it('labels CreateProjectModal from a heading id (aria-labelledby → h2 id)', () => {
        render(<CreateProjectModal isOpen onClose={vi.fn()} onCreate={async () => {}} />);
        const dialog = screen.getByRole('dialog');
        const labelledBy = dialog.getAttribute('aria-labelledby');
        expect(labelledBy).toBe('create-project-title');
        const heading = document.getElementById('create-project-title');
        expect(heading).not.toBeNull();
        expect(heading?.textContent).toContain('Dự án mới');
    });
});

describe('CreateProjectModal là dialog THẬT, không chỉ là hộp có nhãn (nợ M2)', () => {
    // Dialog cuối cùng của app bước vào vòng Tab/Escape mà chưa test nào quây nó: describe dialog semantics
    // chỉ assert aria-labelledby, nên hộp có thể Tab-thoát-ra-ngoài và Esc-vô-nghĩa mà suite vẫn xanh.
    const renderModal = (onClose = vi.fn()) => {
        render(<CreateProjectModal isOpen onClose={onClose} onCreate={async () => {}} />);
        return { dialog: screen.getByRole('dialog'), onClose };
    };

    it('Tab từ control cuối quay về control đầu và Shift+Tab quay ngược lại', () => {
        const { dialog } = renderModal();
        const items = focusablesIn(dialog);
        // Pin số control: nút "Tạo" disabled khi tên rỗng nên isReachable loại nó, hộp còn đúng
        // {đóng, input, huỷ}. Không pin thì markup đổi (input mất, nút bật nhầm) biến vòng lặp dưới
        // thành test chạy trên danh sách một phần tử.
        expect(items).toHaveLength(3);
        const first = items[0];
        const last = items[items.length - 1];

        last.focus();
        expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false);
        expect(document.activeElement).toBe(first);

        first.focus();
        expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(last);
        expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('Escape đóng hộp qua onClose', () => {
        const { dialog, onClose } = renderModal();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('mở từ một nút thì focus vào trong hộp, đóng thì focus trả về đúng nút đó', () => {
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>mo-project-moi</button>
                    <CreateProjectModal isOpen={open} onClose={() => setOpen(false)} onCreate={async () => {}} />
                </>
            );
        }
        render(<Harness />);

        const opener = screen.getByRole('button', { name: 'mo-project-moi' });
        opener.focus();
        fireEvent.click(opener);
        const dialog = screen.getByRole('dialog');
        expect(dialog.contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });
});

describe('accessible names for icon-only controls', () => {
    it('every icon-only button in the Settings dialog has an accessible name', async () => {
        // Hai hàng provider + một key đã nằm trong két sắt: `stored` là điều kiện dựng nút xoá (chỉ có
        // icon, nhánh `{stored && ( … }` trong `ProviderCard`), nên với danh sách rỗng thì vòng quét này
        // chỉ soi được đúng một nút — tức nó pass cả khi mọi control của provider mất nhãn.
        mockFns.list.mockResolvedValue([
            { providerId: 'gemini', configured: true, enabled: true, baseUrl: null, custom: false },
            { providerId: 'custom:mygateway', configured: false, enabled: false, baseUrl: 'https://old.example/v1', custom: true },
        ]);
        window.morphi = {
            ...window.morphi!,
            credentials: { ...window.morphi!.credentials, status: vi.fn().mockResolvedValue({ persistent: true, providers: [{ providerId: 'gemini', configured: true }] }) },
        };
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="providers" />);
        const dialog = await waitFor(() => insideDialog());
        await waitFor(() => expect(screen.getByText('gemini')).toBeInTheDocument());

        // Anti-vacuity: vòng quét phải thực sự thấy control icon-only (nút đóng + nút xoá key).
        expect(iconOnlyButtons(dialog).length).toBeGreaterThanOrEqual(2);
        expect(unnamedIconButtons(dialog)).toEqual([]);
    });

    it('every icon-only button in the Header has an accessible name', () => {
        render(<Header mcpConnected={false} onReconnectMcp={vi.fn()} onShowHelp={vi.fn()} />);
        const header = screen.getByRole('banner');
        // Có ít nhất hai nút icon-only thật (help + theme) — phép đếm là thứ biến `toEqual([])`
        // từ một khẳng định rỗng thành một ràng buộc.
        expect(iconOnlyButtons(header).length).toBeGreaterThanOrEqual(2);
        expect(unnamedIconButtons(header)).toEqual([]);
    });
});

describe('live status region', () => {
    // m12: tên cũ hứa "agent/MCP". Node này chỉ là chip MCP của Header; live region của agent thật
    // (`ChatView.tsx:96`, dòng đang chạy khi phiên trả lời) đã được pin ở `ChatView.test.tsx:56` —
    // một test ở Task 23 không nên đổi tên để ăn công của Task khác, và cũng không nên đếm trùng.
    it('exposes the Header MCP chip as a polite live region (role="status")', () => {
        render(<Header mcpConnected onReconnectMcp={vi.fn()} onShowHelp={vi.fn()} />);
        expect(screen.getByRole('status')).toBeInTheDocument();
    });
});

/**
 * M5 — nguồn text THẬT của mọi file production, để dựng một luật cấu trúc thay cho test "spy nhận chuỗi gì".
 *
 * `import.meta.glob(..., {query:'?raw'})` trả nội dung gốc cho `.ts`/`.tsx` (và chuỗi rỗng với CSS — đã đo,
 * nên phần CSS được pin ở `client/tests/tokens.test.ts` bằng `node:fs`). Loại file test: chúng mock
 * `framer-motion` thật, nên nếu tính vào thì luật sẽ cấm chính cái dụng cụ đo nó.
 */
const PRODUCTION_SOURCES: Array<[string, string]> = Object.entries(
    import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
).filter(([path]) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path));

/** Import framer-motion thật (dạng `from 'framer-motion'`), không tính comment nhắc tới tên thư viện. */
const FRAMER_IMPORT = /from\s+['"]framer-motion['"]/;
const REDUCED_MOTION_CALL = /useReducedMotion\s*\(\s*\)/;

describe('reduced motion — luật cấu trúc §6.6 (jsdom không lật được cờ hệ điều hành)', () => {
    it('every production surface that animates through framer-motion gates itself with useReducedMotion()', () => {
        // Vì sao luật này chứ không phải stub `matchMedia`: round 2 đo trên jsdom thấy stub
        // `(prefers-reduced-motion: reduce)` trả `matches:true` mà `useReducedMotion()` vẫn trả `false`
        // (framer-motion giữ object nó đã đọc). Test render + assert markup vì thế xanh vì lý do sai.
        // Cái jsdom CÓ thể chứng minh: trong cây production không tồn tại surface JS-animation nào chưa gate.
        const users = PRODUCTION_SOURCES.filter(([, src]) => FRAMER_IMPORT.test(src));
        // Anti-vacuity: luật chạy trên cây rỗng luôn xanh ⇒ phải chứng minh có surface để kiểm.
        expect(users.length).toBeGreaterThan(0);
        // Pin danh sách: thêm một file animate bằng JS thứ ba là test ĐỎ, buộc người viết gate —
        // không im lặng ship một animation mà `@media (prefers-reduced-motion)` trong CSS với không tới.
        expect(users.map(([path]) => path.split('/').pop()).sort()).toEqual(['ConfirmModal.tsx', 'Toast.tsx']);
        const ungated = users
            .filter(([, src]) => !REDUCED_MOTION_CALL.test(src))
            .map(([path]) => path);
        expect(ungated).toEqual([]);
    });

    it('the Settings dialog gets its motion from CSS utilities, which the reduced-motion law neutralises', async () => {
        render(<SettingsModal isOpen onClose={vi.fn()} initialTab="general" />);
        const dialog = await waitFor(() => insideDialog());
        // Pin trên tablist (không phải "có bao phần tử mang transition-*"): vòng `TABS.map(...)` trong
        // `SettingsModal` đặt `transition-colors` vào className của CẢ NĂM tab, nên đây là đường chuyển
        // động thật của dialog. Một assert đếm > 0 trên toàn cây sẽ xanh ngay cả khi tablist mất transition
        // — thứ người dùng thật sự thấy.
        const tabs = dialog.querySelectorAll('[role="tab"]');
        expect(tabs.length).toBeGreaterThan(0);
        const untransitioned = Array.from(tabs)
            .filter((tab) => !/\btransition-/.test(tab.className))
            .map((tab) => tab.id);
        expect(untransitioned).toEqual([]);

        // Chiều thứ hai mới là chỗ dễ hỏng: nếu dialog chuyển sang animation bằng JS, assert ở trên trở
        // nên vô nghĩa vì luật CSS không với tới transform do JS viết. Pin thẳng cấu trúc nguồn của dialog.
        const dialogSources = PRODUCTION_SOURCES
            .filter(([path]) => /SettingsModal\.tsx$/.test(path))
            .map(([, src]) => src);
        expect(dialogSources.length).toBeGreaterThan(0);
        for (const src of dialogSources) expect(FRAMER_IMPORT.test(src)).toBe(false);
    });
});

describe('responsive conditions asserted in jsdom (P20-2: no visual sweep here)', () => {
    it('renders the sidebar as an overlay with a scrim below the 760px desktop query', () => {
        // matchMedia trả matches=false cho `(min-width:760px)` <=> viewport < 760px.
        window.matchMedia = makeMatchMedia(() => false);
        const view = render(
            <AppShell sidebar={<div>sidebar-content</div>} sidebarOpen>
                <div>main</div>
            </AppShell>,
        );
        // Dưới 1024px drawer là overlay: có scrim + aside không nằm ở desktop inline.
        // Số breakpoint được pin bằng CHUỖI GỐC, không bằng `DESKTOP_QUERY`: so một hằng số với chính nó
        // là vòng tròn — đổi `(min-width:1024px)` thành bất kỳ giá trị nào khác vẫn xanh, tức cái ngưỡng
        // mà P20-2 giao cho jsdom canh thực ra không có ai canh.
        expect(window.matchMedia).toHaveBeenCalledWith('(min-width:760px)');
        expect(screen.getByTestId('app-shell-scrim')).toBeInTheDocument();
        expect(screen.getByText('sidebar-content').closest('aside')).toHaveAttribute('aria-hidden', 'false');

        // n3: phần này mới làm hai test sidebar ĐỌC ĐƯỢC nhau. Test desktop dưới đây khẳng định
        // `aria-hidden="false"` khi drawer ĐÓNG; ở overlay thì đóng phải ra `true` — nếu chế độ overlay
        // cũng luôn trả `false` thì người dùng AT vẫn đọc một drawer không thấy, và không ai đỏ.
        view.rerender(
            <AppShell sidebar={<div>sidebar-content</div>} sidebarOpen={false}>
                <div>main</div>
            </AppShell>,
        );
        const closed = screen.getByText('sidebar-content').closest('aside');
        expect(closed).toHaveAttribute('aria-hidden', 'true');
        expect(closed!.className).toContain('-translate-x-full');
        // Drawer đóng thì scrim cũng rút: một lớp phủ chặn click không còn chủ.
        expect(screen.queryByTestId('app-shell-scrim')).toBeNull();
    });

    it('renders the sidebar inline (no scrim) at or above the 760px desktop query', () => {
        window.matchMedia = makeMatchMedia((q) => q === DESKTOP_QUERY);
        render(
            <AppShell sidebar={<div>sidebar-content</div>} sidebarOpen={false}>
                <div>main</div>
            </AppShell>,
        );
        expect(window.matchMedia).toHaveBeenCalledWith('(min-width:760px)');
        // >=1024px: scrim biến mất dù `sidebarOpen` false (đó là N3 — không còn drawer ẩn vẫn painted).
        expect(screen.queryByTestId('app-shell-scrim')).toBeNull();
        // Cùng một prop `sidebarOpen={false}` cho ra hai kết quả TRÁI NHAU ở hai chế độ (overlay: 'true',
        // desktop: 'false') — assert này vô nghĩa nếu test trên không chốt chiều ngược lại.
        expect(screen.getByText('sidebar-content').closest('aside')).toHaveAttribute('aria-hidden', 'false');
    });

    it('caps the composer column at max-w-[730px] inside a w-full wrapper', () => {
        render(
            <Composer
                onSend={() => true}
                onStop={vi.fn()}
                models={[]}
                selectedModel=""
                onSelectModel={vi.fn()}
                effort=""
                onSelectEffort={vi.fn()}
                permission="balanced"
                onSelectPermission={vi.fn()}
                onOpenSettings={vi.fn()}
                usedTokens={0}
                totalTokens={0}
                modelName=""
            />,
        );
        // Cơ chế "full width < 768px": wrapper luôn `w-full`, chỉ bị chặn bởi `max-w-[730px]`; dưới ngưỡng
        // desktop 730px+padding thì cap không binding nên nó chiếm hết bề rộng. Ngưỡng điểm ảnh THUỘC Task 25.
        const root = document.querySelector('div.w-full') as HTMLElement;
        expect(root).not.toBeNull();
        expect(root.className).toContain('max-w-[730px]');
    });
});
