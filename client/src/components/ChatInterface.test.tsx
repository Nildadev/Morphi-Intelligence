import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInterface } from './ChatInterface';
import type { ChatState } from '../lib/chatReducer';
import type { ChatUiAction } from '../lib/chatUiReducer';

// The preload bridge is Electron-only; the transport only needs a token to exist.
vi.mock('../lib/token', () => ({ getToken: async () => 'test-token' }));

/**
 * Nhật ký "state sau mỗi action" của chính reducer mà component dùng.
 *
 * Đây là cách DUY NHẤT quan sát được kết quả của live fold trước khi lần reload bắt buộc trong `finally`
 * của `runTurn` đè lên nó — tức là cách chứng minh invariant live == reload ngay trong component thay vì
 * chỉ trong `chatReducer.test.ts`. `importOriginal` bọc implementation thật (không thay thế hành vi),
 * nên đây là mắt ghi hình chứ không phải mock.
 */
const reducerLog: { action: ChatUiAction; state: ChatState }[] = [];
vi.mock('../lib/chatUiReducer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/chatUiReducer')>();
    return {
        ...actual,
        chatReducer: (state: ChatState, action: ChatUiAction): ChatState => {
            const next = actual.chatReducer(state, action);
            reducerLog.push({ action, state: next });
            return next;
        },
    };
});

/**
 * jsdom có sẵn `Response`/`Headers`/`ReadableStream` (từ Node) nên transport chạy thật trong test,
 * nhưng không có `matchMedia` và `scrollIntoView` — cả hai được gọi lúc mount nên phải stub.
 */
window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia;
const mobileMatchMedia = window.matchMedia;
Element.prototype.scrollIntoView = vi.fn();

const enc = new TextEncoder();

const line = (frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`;
const durable = (type: string, payload: unknown, seq: number) => ({ id: `evt_${seq}`, seq, type, payload, ts: 1 });
const live = (type: string, payload: unknown) => ({ id: `evt_${type}`, type, payload, ts: 1 });

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (frames: unknown[]) =>
    new Response(frames.map(line).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

/** `Promise` kèm chốt mở — để giữ một request treo giữa chừng (`starting` window). */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Stream do test điều khiển: `push` một frame, `fail` lần đọc kế tiếp, `close` khi hết. */
function openSse() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let broken = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    return {
        response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        // Sau khi reader hỏng thì enqueue sẽ throw — `push` im lặng mô tả đúng server đã đóng socket.
        push: (frame: unknown) => { if (!broken) controller.enqueue(enc.encode(line(frame))); },
        fail: (error: unknown) => { broken = true; try { controller.error(error); } catch { /* rồi */ } },
        close: () => { broken = true; try { controller.close(); } catch { /* đã đóng rồi */ } },
    };
}

const abortError = () => new DOMException('aborted', 'AbortError');

/**
 * Browser thật cắt `response.body` (reject reader với `AbortError`) khi `signal` abort; jsdom thì không.
 * Stub cũ vì thế KHÔNG ĐỌC `init.signal` chút nào, và một lần abort ngoài ý muốn — điển hình là effect
 * mount chạy lại sau mỗi render và gọi `abortRef.current?.abort()` — hoàn toàn vô hình với 11 test.
 * Đây là bản sao hành vi thật: abort giữa chừng làm stream của response error với `AbortError`.
 */
async function withAbortBody(response: Response, signal: AbortSignal | null | undefined): Promise<Response> {
    if (!signal || response.body === null) return response;
    if (signal.aborted) throw abortError();
    const source = response.body.getReader();
    let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(controller) { sink = controller; },
        async pull(controller) {
            try {
                const { done, value } = await source.read();
                if (done) controller.close();
                else if (value !== undefined) controller.enqueue(value);
            } catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) { source.cancel(reason).catch(() => { /* stream đã chết */ }); },
    });
    signal.addEventListener('abort', () => { sink?.error(abortError()); }, { once: true });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

const SESSION_ID = 's9';
const summary = {
    id: SESSION_ID,
    projectId: 'p1',
    title: 'Cuộc trò chuyện mới',
    createdAt: 1,
    lastUpdated: 2,
    isPinned: false,
    status: 'idle',
};

/** Hàng bền của `SessionDetail.messages` — cùng nội dung hai frame `user/message`/`assistant/message`. */
const userMsg = { id: 'u1', role: 'user', content: 'xin chào', source: 'user', steps: [], createdAt: 1, superseded: false };
const assistantMsg = {
    id: 'a1', role: 'assistant', content: 'Chào bạn',
    steps: [{ type: 'text', content: 'Chào bạn' }], createdAt: 1, superseded: false,
};
const regeneratedMsg = {
    id: 'a2', role: 'assistant', content: 'Trả lời mới',
    steps: [{ type: 'text', content: 'Trả lời mới' }], createdAt: 2, superseded: false,
};

/** `GET /api/sessions/:id` là projection thật; test đổi nội dung qua `withRows` để mô phỏng reload. */
let rows: unknown[] = [];
const withRows = (...messages: unknown[]) => { rows = messages; };

const streamFrames = () => [
    durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
    durable('user/message', { messageId: 'u1', content: 'xin chào', source: 'user' }, 2),
    live('assistant/delta', { turnId: 't1', text: 'Chào ' }),
    live('assistant/delta', { turnId: 't1', text: 'bạn' }),
    durable('assistant/message', { messageId: 'a1', content: 'Chào bạn', finishReason: 'stop', callIds: [] }, 3),
    live('agent/status', { state: 'idle', turnId: 't1' }),
    durable('turn/end', { turnId: 't1', reason: 'completed' }, 4),
];

const handlers = new Map<string, () => Response | Promise<Response>>();
const seen: [string, RequestInit | undefined][] = [];

const routeOf = (url: string, init?: RequestInit) => `${(init?.method ?? 'GET').toUpperCase()} ${url.split('?')[0]}`;

const responder = vi.fn(async (url: unknown, init?: RequestInit) => {
    const key = routeOf(String(url), init);
    seen.push([key, init]);
    const handler = handlers.get(key);
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    // `signal` được tôn trọng như browser thật (xem `withAbortBody`).
    return withAbortBody(await handler(), init?.signal);
});
vi.stubGlobal('fetch', responder);

function bodyOf(key: string): unknown {
    const call = seen.find(([k]) => k === key);
    expect(call, key).toBeDefined();
    return call?.[1]?.body === undefined ? undefined : JSON.parse(String(call?.[1]?.body));
}

const countOf = (key: string) => seen.filter(([k]) => k === key).length;

/**
 * Hai state quanh lần reload cuối cùng trong nhật ký reducer: `live` là kết quả live fold ĐÚNG LÚC
 * action `session/reload` được đưa vào, `reloaded` là projection đè lên. `live == reload` nghĩa là hai
 * cái phải cùng một tập hàng bền — nếu fold sai thì `reloaded` ăn pass một cách rỗng tuếch, đó chính là
 * lỗ hổng mà `sse()` buffer sẵn từng che.
 */
function liveVsReload(): { live: ChatState; reloaded: ChatState } {
    for (let i = reducerLog.length - 1; i > 0; i -= 1) {
        if (reducerLog[i].action.type === 'session/reload') {
            return { live: reducerLog[i - 1].state, reloaded: reducerLog[i].state };
        }
    }
    throw new Error('reducer log không có lần reload nào');
}

beforeEach(() => {
    seen.length = 0;
    reducerLog.length = 0;
    handlers.clear();
    withRows(userMsg, assistantMsg);
    handlers.set('GET /api/projects', () => json([{ id: 'p1', name: 'Demo', createdAt: 1, lastActive: 1 }]));
    // Rail mặc định trống: các test stream đi qua đúng luồng "tin nhắn đầu tiên" (tạo project+session
    // rồi stream), còn test mở phiên ghi đè lại list này.
    handlers.set('GET /api/sessions', () => json([]));
    handlers.set('GET /api/models', () => json([{
        id: 'google:gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google',
        providerLabel: 'Google', supportsTools: true, context: 1_048_576,
        efforts: ['low', 'medium', 'high'],
    }]));
    handlers.set('GET /api/mcp/status', () => json({
        connected: true, studioLinked: false, server: { source: 'none', path: null, version: null }, logs: [],
    }));
    handlers.set(`GET /api/sessions/${SESSION_ID}`, () => json({ ...summary, messages: rows, steps: [], skills: [] }));
    handlers.set('POST /api/sessions', () => json({ ...summary, messages: [], steps: [], skills: [] }, 201));
    handlers.set('POST /api/chat/cancel', () => json({ sessionId: SESSION_ID, cancelled: true }));
    handlers.set('POST /api/approvals/ap1', () => json({ ok: true, approvalId: 'ap1', decision: 'allow', scope: 'once' }));
});

afterEach(() => {
    cleanup();
    responder.mockClear();
    window.matchMedia = mobileMatchMedia;
    localStorage.clear();
});

const input = () => screen.getByPlaceholderText('Hỏi Morphi bất cứ điều gì…');

function send(text: string): void {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: false });
}

/**
 * Fixture chung cho ba test phê duyệt: một hàng assistant bền kèm approval treo, dựng bằng đúng con
 * đường thật (stream → projection → modal). Trước round 3 mỗi test tự viết lại 4 frame này.
 */
const approvalStream = () => sse([
    durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
    durable('assistant/message', {
        messageId: 'a1', content: 'Cần chạy lệnh', finishReason: 'tool_calls', callIds: ['c1'],
    }, 2),
    durable('approval/request', {
        approvalId: 'ap1', callId: 'c1', name: 'run_command', args: { cmd: 'ls' }, risk: 'high',
    }, 3),
    live('agent/status', { state: 'waiting_approval', turnId: 't1' }),
]);

/** Mở modal phê duyệt rồi trả về khi nó đã hiện. */
async function openApprovalModal(): Promise<void> {
    handlers.set('POST /api/chat/stream', () => approvalStream());
    render(<ChatInterface />);
    await screen.findByText('Hôm nay bạn muốn xây gì?');
    send('xin chào');
    await screen.findByRole('button', { name: 'Cho phép một lần' });
}

describe('ChatInterface on the harness protocol', () => {
    it('opens a session from its summary list plus one detail fetch', async () => {
        handlers.set('GET /api/sessions', () => json([{ ...summary }]));
        render(<ChatInterface />);
        expect(await screen.findByText('xin chào')).not.toBeNull();
        expect(await screen.findByText('Chào bạn')).not.toBeNull();
        // Route cũ nhồi `messages` vào `/api/sessions`; giờ rail chỉ nhận `SessionSummary`,
        // projection chỉ được fetch khi mở phiên.
        expect(countOf('GET /api/sessions')).toBe(1);
        expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1);
    });

    it('stub cuts the response body when init.signal aborts, like a real browser', async () => {
        // Đây chính là điều làm Critical #1 thấy được: stub cũ không đọc `init.signal` nên một lần abort
        // ngoài ý muốn (effect mount chạy lại và gọi `abortRef.current?.abort()`) hoàn toàn vô hình với
        // phép thử. Pin luôn hợp đồng của stub, để nó không âm thầm quay lại.
        const controller = new AbortController();
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        const response = await responder('/api/chat/stream', { method: 'POST', signal: controller.signal });
        const pending = (response as Response).body!.getReader().read();
        controller.abort();
        await expect(pending).rejects.toThrow(/aborted/i);
    });

    it('fetches the project list once on mount and never re-runs the mount effect', async () => {
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');
        // Chuỗi useCallback đi qua `showToast` (không memo) khiến effect mount tự chạy lại sau MỖI
        // render, mà mỗi render lại `setProjects(mảng mới)` → lặp vô hạn gọi /api/projects.
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(countOf('GET /api/projects')).toBe(1);
    });

    it('stops the turn when Stop is pressed during the starting window', async () => {
        // `disabled` vẽ nút Stop suốt `ensureSession`, nhưng lúc đó `abortRef.current` còn `null` và
        // `api.chat.cancel` chỉ nhắm vào một lượt chưa tồn tại. Cờ `cancelRequestedRef` là thứ duy nhất
        // biến cú bấm đó thành "không chạy": sau khi `POST /api/sessions` trả về, stream KHÔNG được mở.
        withRows();
        const gate = deferred<Response>();
        handlers.set('POST /api/sessions', () => gate.promise);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        await waitFor(() => expect(countOf('POST /api/sessions')).toBe(1));
        fireEvent.click(await screen.findByRole('button', { name: 'Dừng tạo' }));
        gate.resolve(json({ ...summary, messages: [], steps: [], skills: [] }, 201));

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Dừng tạo' })).toBeNull());
        expect(countOf('POST /api/chat/stream')).toBe(0);
        // Không có lượt nào chạy thì cũng không có gì để cancel trên server.
        expect(countOf('POST /api/chat/cancel')).toBe(0);
        // No turn ran, so no durable bubble was created — the text only survives in the composer.
        expect(input()).toHaveValue('xin chào');
        expect(screen.queryByText('Chào bạn')).toBeNull();
        // Bản nháp chỉ sống ở composer: phần tử duy nhất mang chữ là <textarea>, không có hàng bền.
        { const holders = screen.getAllByText('xin chào'); expect(holders).toHaveLength(1); expect(holders[0]).toBe(input()); }
    });

    it('keeps the submitted text and reconciles the new session when Stop lands in the starting window (C13)', async () => {
        const gate = deferred<Response>();
        handlers.set('POST /api/sessions', () => gate.promise);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('giữ tin này');
        await waitFor(() => expect(countOf('POST /api/sessions')).toBe(1));
        fireEvent.click(await screen.findByRole('button', { name: 'Dừng tạo' }));
        gate.resolve(json({ ...summary, messages: [], steps: [], skills: [] }, 201));

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Dừng tạo' })).toBeNull());
        // The draft was cleared only because the parent accepted it; Stop during `starting` restores it.
        expect(input()).toHaveValue('giữ tin này');
        // The session that `ensureSession` just created is reconciled through the normal finally path.
        await waitFor(() => expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1));
        expect(countOf('POST /api/chat/stream')).toBe(0);
        // Bản nháp chỉ sống ở composer: chưa có hàng bền nào được ghi.
        { const holders = screen.getAllByText('giữ tin này'); expect(holders).toHaveLength(1); expect(holders[0]).toBe(input()); }
    });

    it('toggles the sidebar from the header control instead of only ever opening it', async () => {
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');
        const aside = document.querySelector('aside');
        expect(aside).not.toBeNull();
        // Narrow width: the drawer starts closed so the chat owns the space.
        expect(aside).toHaveAttribute('aria-hidden', 'true');

        const toggle = () => screen.getByRole('button', { name: 'Bật/tắt thanh bên' });
        fireEvent.click(toggle());
        await waitFor(() => expect(aside).toHaveAttribute('aria-hidden', 'false'));

        fireEvent.click(toggle());
        await waitFor(() => expect(aside).toHaveAttribute('aria-hidden', 'true'));
    });

    it('collapses the desktop rail — not the mobile drawer — from the header, and persists it', async () => {
        // Bản cũ chỉ test nhánh <1024px trong khi chính finding repro ở ≥lg: AppShell GỠ entire aside khi
        // `isDesktop && sidebarCollapsed`, còn drawer thì chỉ đổi `aria-hidden`. Hai con đường khác nhau.
        window.matchMedia = vi.fn((query: string) => ({
            matches: query === '(min-width:760px)',
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })) as unknown as typeof window.matchMedia;
        localStorage.clear();

        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');
        expect(document.querySelector('aside')).not.toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Bật/tắt thanh bên' }));
        await waitFor(() => expect(document.querySelector('aside')).toBeNull());
        // Nút ở Sidebar mới là chỗ ghi key; con đường header phải ghi nốt, nếu không reload mở lại sidebar
        // mà user vừa đóng từ header.
        expect(localStorage.getItem('morphi.sidebarCollapsed')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: 'Bật/tắt thanh bên' }));
        await waitFor(() => expect(document.querySelector('aside')).not.toBeNull());
        expect(localStorage.getItem('morphi.sidebarCollapsed')).toBe('false');
    });

    it('labels the open tool from the call status, not from the progress lines', async () => {
        // `turn/end` mới là thứ xóa `chat.toolProgress`, nên một lượt chạy tool xong rồi viết câu trả lời
        // dài dán nhãn "Đang chạy tool" suốt lúc model đang soạn: nhãn nói sai sự thật trên live region.
        withRows();
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));

        const push = async (frame: unknown) => {
            stream.push(frame);
            await new Promise(resolve => setTimeout(resolve, 0));
        };
        await push(durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1));
        await push(durable('user/message', { messageId: 'u1', content: 'xin chào', source: 'user' }, 2));
        await push(durable('assistant/message', { messageId: 'a1', content: 'Để mình xem.', finishReason: 'stop', callIds: ['c1'] }, 3));
        await push(live('tool/call', { callId: 'c1', name: 'run_command', args: {} }));
        await push(live('tool/progress', { callId: 'c1', message: 'đang chạy lệnh' }));

        expect(screen.getByText('Đang chạy tool')).toBeInTheDocument();

        await push(live('tool/result', { callId: 'c1', status: 'done', result: 'ok', durationMs: 12 }));
        await push(live('assistant/delta', { turnId: 't1', text: 'Xong rồi.' }));

        // Successful tools drop their activity line (Ruling 9): the progress map keeps the entry until
        // `turn/end`, so the header must switch to "Đang nghĩ" from the call status, not the map.
        expect(screen.queryByText('đang chạy lệnh')).toBeNull();
        expect(screen.getByText('Đang nghĩ')).toBeInTheDocument();
        expect(screen.queryByText('Đang chạy tool')).toBeNull();

        stream.close();
        await waitFor(() => expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1));
        // Lượt đóng lại rồi thì không có gì "đang chạy" nữa, kể cả khi hàng bền còn giữ call chưa settling.
        expect(screen.queryByText('Đang chạy tool')).toBeNull();
    });

    it('sends a welcome suggestion verbatim, without hidden prompt expansion', async () => {
        handlers.set('POST /api/chat/stream', () => sse(streamFrames()));
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        fireEvent.click(screen.getByRole('button', { name: 'Debug placement' }));

        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        expect(bodyOf('POST /api/chat/stream')).toMatchObject({ message: 'Debug placement' });
    });

    it('sends a welcome suggestion with the model and the effort the chip shows', async () => {
        handlers.set('POST /api/chat/stream', () => sse(streamFrames()));
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        fireEvent.click(screen.getByRole('combobox', { name: 'Chọn mô hình' }));
        fireEvent.click(await screen.findByText('Gemini 2.5 Flash'));
        // Task 31D: the level is now a draggable slider on the effort pill; dragging to the top stop
        // selects `high` and the request carries the level name.
        fireEvent.click(screen.getByRole('button', { name: 'Mức suy nghĩ' }));
        fireEvent.change(screen.getByRole('slider', { name: 'Mức suy nghĩ' }), { target: { value: '2' } });

        fireEvent.click(screen.getByRole('button', { name: 'Debug placement' }));

        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        expect(bodyOf('POST /api/chat/stream')).toMatchObject({
            message: 'Debug placement',
            model: 'google:gemini-2.5-flash',
            effort: 'high',
        });
        // The default permission mode is `balanced`, which the client deliberately omits so the
        // server keeps its historical behaviour — a regression would start shipping it on every turn.
        expect((bodyOf('POST /api/chat/stream') as Record<string, unknown> | undefined)?.permissionMode).toBeUndefined();
    });

    it('streams a scripted turn and keeps exactly one user bubble', async () => {
        handlers.set('POST /api/chat/stream', () => sse(streamFrames()));
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        expect((await screen.findAllByText((_, node) => node?.textContent === 'Chào bạn')).length).toBeGreaterThan(0);

        // Server event là nguồn duy nhất: không có bong bóng user optimistic nên không thể trùng.
        expect(screen.getAllByText('xin chào')).toHaveLength(1);
        expect(bodyOf('POST /api/chat/stream')).toMatchObject({ message: 'xin chào', sessionId: SESSION_ID });
        // Hai lần đọc: lần đầu khi frame `user/message` tới để đưa session lên sidebar giữa lượt,
        // lần sau sau `turn/end` vì reload projection là bản authoritative (rowSeq chỉ server biết).
        expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(2);
    });

    it('ends a live stream in exactly the state the reload projection gives (live == reload)', async () => {
        // Bất biến của Task 19A từng được pin chỉ ở tầng thuần (`chatReducer.test.ts`), còn ở tầng
        // component thì vô hình: `sse()` buffer sẵn nên mọi frame rơi vào MỘT lần đọc, và lần reload bắt
        // buộc trong `finally` của `runTurn` đè kết quả live fold TRƯỚC khi có bất kỳ assert nào — một
        // fold sai vẫn ăn pass. Đây là phiên bản đẩy frame từng cái, so state ngay trước và ngay sau
        // lần reload, trên đúng cùng những hàng bền.
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        for (const frame of streamFrames()) {
            stream.push(frame);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        stream.close();
        await waitFor(() => expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1));

        const { live: liveState, reloaded } = liveVsReload();
        // Live fold phải TỰ nó có đủ hai hàng bền — không được nợ lần reload.
        expect(liveState.messages.map(m => m.id)).toEqual(['u1', 'a1']);
        expect(liveState.settled).toBe('completed');
        expect(liveState.draft.content).toBe('');
        // ... và đó phải là đúng những gì projection trả về cho cùng các hàng bền đó. Hai mảng khác
        // instance (assert dưới) nên `toEqual` ở đây là so sánh nội dung thật, không phải tự so.
        expect(reloaded.messages).toEqual(liveState.messages);
        expect(reloaded.messages).not.toBe(liveState.messages);
        // `rowSeqById` do live fold dựng phải sống sót qua reload: hàng bền trên wire không mang `seq`,
        // nên map đó là thứ duy nhất để `compaction/summary` khớp được hàng.
        expect(liveState.rowSeqById).toEqual({ u1: 2, a1: 3 });
        expect(reloaded.rowSeqById).toEqual(liveState.rowSeqById);
    });

    it('shows the queued notice for a 202 without pretending a new turn started', async () => {
        withRows();
        handlers.set('POST /api/chat/stream', () => json({ queued: true }, 202));
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        // The queue card lives in the composer: header + the queued text + the steer hint.
        expect(await screen.findByText('Tin nhắn trong hàng đợi (1)')).not.toBeNull();
        expect(screen.getByText('xin chào')).not.toBeNull();
        expect(screen.getByText('Định tuyến ở bước tiếp theo · tự tắt sau khi gửi')).not.toBeNull();
        // Không có bong bóng assistant nào được bịa cho một lượt chưa bắt đầu.
        expect(screen.queryByText('Chào bạn')).toBeNull();
    });

    it('restores the undone user text into the composer after undo', async () => {
        handlers.set('GET /api/sessions', () => json([{ ...summary }]));
        handlers.set(`POST /api/sessions/${SESSION_ID}/undo-message`, () => {
            withRows();
            return json({ ...summary, messages: [], steps: [], skills: [] });
        });
        render(<ChatInterface />);
        expect(await screen.findByText('xin chào')).not.toBeNull();
        expect(screen.getByText('Chào bạn')).not.toBeNull();

        fireEvent.click(await screen.findByRole('button', { name: 'Hoàn tác' }));

        // The turn is gone from the transcript, and its text is back in the input to edit/resend.
        await waitFor(() => expect(screen.queryByText('Chào bạn')).toBeNull());
        expect(bodyOf(`POST /api/sessions/${SESSION_ID}/undo-message`)).toEqual({ messageId: 'u1' });
        await waitFor(() => expect(input()).toHaveValue('xin chào'));
        { const holders = screen.getAllByText('xin chào'); expect(holders).toHaveLength(1); expect(holders[0]).toBe(input()); }
    });

    it('keeps the textarea enabled while streaming so a second message can steer the turn', async () => {
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        stream.push(durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1));
        stream.push(live('assistant/delta', { turnId: 't1', text: 'nửa câu' }));
        await waitFor(() => expect(document.body.textContent).toContain('nửa câu'));

        // The input must stay editable mid-turn: typing morphs the Stop square into the steer arrow.
        expect(input()).not.toBeDisabled();
        fireEvent.change(input(), { target: { value: 'bổ sung thêm' } });
        expect(screen.queryByRole('button', { name: 'Dừng tạo' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Gửi chèn' })).toBeEnabled();
        fireEvent.keyDown(input(), { key: 'Enter', shiftKey: false });

        // Steer goes through the same stream endpoint; the server queues it into the running turn.
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(2));
        const bodies = seen
            .filter(([key]) => key === 'POST /api/chat/stream')
            .map(([, init]) => JSON.parse(String(init?.body)));
        expect(bodies[0]).toMatchObject({ message: 'xin chào' });
        expect(bodies[1]).toMatchObject({ message: 'bổ sung thêm' });
        // Still the first turn: no second welcome-level state, the draft row is the only live row.
        expect(document.body.textContent).toContain('nửa câu');
        stream.close();
    });

    it('stop cancels the running turn instead of only dropping the socket', async () => {
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        stream.push(durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1));
        stream.push(live('assistant/delta', { turnId: 't1', text: 'nửa câu' }));

        fireEvent.click(await screen.findByRole('button', { name: 'Dừng tạo' }));
        stream.fail(new DOMException('aborted', 'AbortError'));

        // `cancel` đi qua `getToken()` (async) nên fetch được ghi lại ở vi-task kế tiếp.
        await waitFor(() => expect(countOf('POST /api/chat/cancel')).toBe(1));
        expect(bodyOf('POST /api/chat/cancel')).toEqual({ sessionId: SESSION_ID });
        // Abort giữa chừng là "đã dừng", không phải lỗi; reload mới là bản thật.
        await waitFor(() => expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1));
        expect(screen.queryByText(/không kết nối được/i)).toBeNull();
        // Draft live bị `turn/end reason:'cancelled'` xoá; `waitFor` là chỗ AnimatePresence cần để
        // bong bóng đã rời state thực sự rời DOM.
        await waitFor(() => expect(document.body.textContent).not.toContain('nửa câu'));
        // The stop is not a user-facing debug line; it settles silently with no alert.
        expect(screen.queryByText('Đã dừng lượt trả lời.')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps a second send from opening a parallel turn while the first is still setting up', async () => {
        // `streaming` chỉ bật được trong `runTurn`, còn `ensureSession()` (POST /api/sessions) thì chờ
        // thật. Trong khoảng đó input chưa bị khoá, nên luồng "tin nhắn đầu tiên" cần một khoá đồng bộ
        // — nếu không, hai lượt chạy song song trên cùng một transcript.
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('tin một');
        send('tin hai');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        expect(countOf('POST /api/sessions')).toBe(1);
        expect(bodyOf('POST /api/chat/stream')).toMatchObject({ message: 'tin một' });
        stream.close();
    });

    it('keeps a new chat out of the sidebar until its first message lands', async () => {
        withRows();
        const stream = openSse();
        handlers.set('POST /api/chat/stream', () => stream.response);
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        expect(screen.queryByTestId(`session-row-${SESSION_ID}`)).toBeNull();

        fireEvent.click(screen.getAllByRole('button', { name: 'Cuộc trò chuyện mới' })[0]);
        await waitFor(() => expect(countOf('POST /api/sessions')).toBe(1));
        // Created server-side, but still invisible: no message has landed on it yet.
        expect(screen.queryByTestId(`session-row-${SESSION_ID}`)).toBeNull();
        expect(screen.getByText('Hôm nay bạn muốn xây gì?')).toBeInTheDocument();

        send('xin chào');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        for (const frame of streamFrames()) {
            stream.push(frame);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        // The reload now projects the durable rows, so upserting the summary is allowed.
        withRows(userMsg, assistantMsg);
        stream.close();

        expect(await screen.findByTestId(`session-row-${SESSION_ID}`)).toBeInTheDocument();
    });

    it('keeps two background turns streaming while the user switches between their chats', async () => {
        // Deepseek-style background chats: a turn belongs to its session, not to the pane. Switching
        // must NOT abort the outgoing SSE (the server cancels on disconnect), and frames for a
        // background session fold into that session's cache instead of the visible transcript.
        const other = { ...summary, id: 's10', title: 'Phiên B' };
        handlers.set('GET /api/sessions', () => json([{ ...summary }, other]));
        handlers.set('GET /api/sessions/s10', () =>
            json({ ...other, messages: [{ ...userMsg, id: 'u9', content: 'nội dung phiên B' }], steps: [], skills: [] }));
        const streamA = openSse();
        const streamB = openSse();
        let streamCalls = 0;
        handlers.set('POST /api/chat/stream', () => (streamCalls++ === 0 ? streamA.response : streamB.response));
        render(<ChatInterface />);
        await screen.findByText('xin chào');

        send('tin A');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(1));
        streamA.push(durable('turn/start', { turnId: 'tA', modelSelection: 'auto', trigger: 'user' }, 1));
        streamA.push(live('assistant/delta', { turnId: 'tA', text: 'nửa câu A' }));
        await waitFor(() => expect(document.body.textContent).toContain('nửa câu A'));

        fireEvent.click(screen.getByText('Phiên B'));
        expect(await screen.findByText('nội dung phiên B')).not.toBeNull();
        // The outgoing turn is untouched: no abort, no server cancel.
        const signalA = (seen.find(([k]) => k === 'POST /api/chat/stream')?.[1] as RequestInit | undefined)?.signal;
        expect(signalA?.aborted).toBe(false);
        expect(countOf('POST /api/chat/cancel')).toBe(0);
        // ...and the sidebar says A is still working, even though B owns the pane.
        expect(screen.getByTestId('session-running-s9')).toBeInTheDocument();
        expect(screen.queryByTestId('session-running-s10')).toBeNull();

        // A frame arriving while B is open belongs to A's cache, never to B's transcript.
        streamA.push(live('assistant/delta', { turnId: 'tA', text: ' vẫn chạy' }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.body.textContent).not.toContain('vẫn chạy');

        // Sending in B opens a second, independent stream while A is still live.
        send('tin B');
        await waitFor(() => expect(countOf('POST /api/chat/stream')).toBe(2));
        const bodies = seen
            .filter(([key]) => key === 'POST /api/chat/stream')
            .map(([, init]) => JSON.parse(String(init?.body)));
        expect(bodies[0]).toMatchObject({ sessionId: SESSION_ID, message: 'tin A' });
        expect(bodies[1]).toMatchObject({ sessionId: 's10', message: 'tin B' });
        streamB.push(durable('turn/start', { turnId: 'tB', modelSelection: 'auto', trigger: 'user' }, 1));
        streamB.push(live('assistant/delta', { turnId: 'tB', text: 'trả lời B' }));
        await waitFor(() => expect(document.body.textContent).toContain('trả lời B'));
        // Two live turns, two running rows — the indicator is per session, not per pane.
        expect(screen.getByTestId('session-running-s9')).toBeInTheDocument();
        expect(screen.getByTestId('session-running-s10')).toBeInTheDocument();

        // Returning to A restores the live partial text from the background cache...
        const rowA = await screen.findByTestId(`session-row-${SESSION_ID}`);
        fireEvent.click(rowA.querySelector('button') as HTMLButtonElement);
        await waitFor(() => expect(document.body.textContent).toContain('nửa câu A vẫn chạy'));
        // ...and the still-open stream keeps appending in real time.
        streamA.push(live('assistant/delta', { turnId: 'tA', text: ' tiếp' }));
        await waitFor(() => expect(document.body.textContent).toContain('nửa câu A vẫn chạy tiếp'));
        // B's own live text is not in A's pane.
        expect(document.body.textContent).not.toContain('trả lời B');

        streamA.close();
        streamB.close();
        // Both turns settled: the running dots go away again.
        await waitFor(() => expect(screen.queryByTestId('session-running-s9')).toBeNull());
        await waitFor(() => expect(screen.queryByTestId('session-running-s10')).toBeNull());
    });

    it('opens a subagent child session in the docked side panel without replacing the main transcript', async () => {
        // The child row is a door into the child's own transcript. Opening it used to swap the main
        // pane (losing the parent's scroll and the turn the child belongs to); it must now fill the
        // side panel and leave the parent conversation untouched.
        const childSessionId = 'sess_child';
        const subagentMessage = {
            id: 'sub_sub1', role: 'assistant', content: '',
            steps: [{
                type: 'subagent', subagentId: 'sub1', task: 'Tóm tắt hoá đơn',
                childSessionId, status: 'done', summary: 'Xong', toolCount: 2,
                failedToolCount: 0, durationMs: 31_000,
            }],
            createdAt: 3, superseded: false,
        };
        withRows(userMsg, subagentMessage);
        handlers.set('GET /api/sessions', () => json([{ ...summary }]));
        handlers.set(`GET /api/sessions/${childSessionId}`, () => json({
            ...summary, id: childSessionId, title: 'Phiên con',
            messages: [{
                ...assistantMsg,
                id: 'a_child',
                content: 'Nội dung phiên con',
                steps: [{ type: 'text', content: 'Nội dung phiên con' }],
            }],
            steps: [], skills: [],
        }));
        handlers.set(`GET /api/sessions/${SESSION_ID}/subagent/list`, () => json([]));
        render(<ChatInterface />);
        await screen.findByText('xin chào');

        expect(screen.queryByTestId('side-panel')).toBeNull();
        fireEvent.click(await screen.findByRole('button', { name: /SubAgent general-purpose/ }));

        // The child transcript loads into the panel...
        expect(await screen.findByTestId('side-panel')).toBeInTheDocument();
        expect(await screen.findByText('Nội dung phiên con')).toBeInTheDocument();
        // ...while the parent session is still the one on screen behind it.
        expect(screen.getByText('xin chào')).toBeInTheDocument();
        expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1);

        // Escape dismisses the panel (the overlay form is focus-trapped at narrow widths).
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('side-panel')).toBeNull());
    });

    it('regenerate posts the assistant message id and replaces that answer', async () => {
        handlers.set('GET /api/sessions', () => json([{ ...summary }]));
        handlers.set('POST /api/chat/regenerate', () => sse([
            durable('turn/start', {
                turnId: 't2', modelSelection: 'auto', trigger: 'regenerate',
                regeneratedFrom: { userMessageId: 'u1', supersedesAssistantMessageId: 'a1' },
            }, 5),
            durable('assistant/message', {
                messageId: 'a2', content: 'Trả lời mới', finishReason: 'stop', callIds: [],
            }, 6),
            durable('turn/end', { turnId: 't2', reason: 'completed' }, 7),
        ]));
        render(<ChatInterface />);
        expect((await screen.findAllByText((_, node) => node?.textContent === 'Chào bạn')).length).toBeGreaterThan(0);

        withRows(userMsg, regeneratedMsg);
        fireEvent.click(await screen.findByRole('button', { name: 'Tạo lại câu trả lời' }));
        expect((await screen.findAllByText((_, node) => node?.textContent === 'Trả lời mới')).length).toBeGreaterThan(0);
        expect(bodyOf('POST /api/chat/regenerate')).toEqual({ sessionId: SESSION_ID, assistantMessageId: 'a1' });
        // Hàng bị superseded biến mất khỏi projection, đúng như reload trả về.
        await waitFor(() => expect(screen.queryByText('Chào bạn')).toBeNull());
    });

    it('maps a transport error code to Vietnamese copy instead of sniffing the message', async () => {
        handlers.set('POST /api/chat/stream', () =>
            json({ error: { code: 'NO_PROVIDER', message: 'chưa có provider nào' } }, 400));
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        expect(await screen.findByText(/chưa cấu hình provider/i)).not.toBeNull();
        expect(screen.queryByText('Model Not Found')).toBeNull();
        expect(screen.queryByText('Missing API Key')).toBeNull();
        // The failure never reached the durable log (HTTP 400 before any frame), so the projection
        // has no `error`. The reload in `runTurn`'s finally must not erase the live card anyway.
        await waitFor(() => expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBe(1));
        expect(screen.getByText(/chưa cấu hình provider/i)).toBeInTheDocument();
    });

    it('clears the previous session error card when switching sessions', async () => {
        // Live-only state (the error card) belongs to the session that produced it. `session/reload`
        // deliberately keeps `error` after `turn/end`, so a switch must reset the transcript first.
        handlers.set('GET /api/sessions', () => json([
            { ...summary },
            { ...summary, id: 's10', title: 'Phiên khác' },
        ]));
        handlers.set('GET /api/sessions/s10', () => json({
            ...summary,
            id: 's10',
            title: 'Phiên khác',
            messages: [{ ...userMsg, id: 'u2', content: 'nội dung phiên khác' }],
            steps: [],
            skills: [],
        }));
        handlers.set('POST /api/chat/stream', () =>
            json({ error: { code: 'NO_PROVIDER', message: 'chưa có provider nào' } }, 400));
        render(<ChatInterface />);
        await screen.findByText('Chào bạn');

        send('xin chào');
        expect(await screen.findByText(/chưa cấu hình provider/i)).not.toBeNull();

        // jsdom has no matchMedia, so AppShell treats the viewport as a closed drawer and marks the
        // sidebar `aria-hidden`. The row testid still resolves; click its button directly.
        const row = await screen.findByTestId('session-row-s10');
        const button = row.querySelector('button');
        expect(button).not.toBeNull();
        fireEvent.click(button as HTMLButtonElement);

        expect(await screen.findByText('nội dung phiên khác')).not.toBeNull();
        expect(screen.queryByText(/chưa cấu hình provider/i)).toBeNull();
    });

    it('restores a persisted provider error after the session is reopened', async () => {
        // A fresh mount has no background cache: the only source is the durable projection. The
        // server hydrates `SessionDetail.error` from the latest `turn/end` (deepseek keeps
        // `reason.failure`), so reopening must show the same failure card the live stream showed.
        handlers.set('GET /api/sessions', () => json([{ ...summary }]));
        handlers.set(`GET /api/sessions/${SESSION_ID}`, () => json({
            ...summary,
            messages: rows,
            steps: [],
            skills: [],
            error: { code: 'http_error', message: 'provider exploded', retryable: false },
        }));
        render(<ChatInterface />);

        expect(await screen.findByText('provider exploded')).not.toBeNull();
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.queryByText('Hôm nay bạn muốn xây gì?')).toBeNull();
    });

    it('surfaces a regenerate rejected with 409 SESSION_BUSY by code, not by message', async () => {
        // `POST /api/chat/regenerate` trên phiên bận trả về 409 + message tiếng Việt của server.
        // Client không đoán qua chuỗi: bản copy là của `ERROR_COPY[SESSION_BUSY]`.
        handlers.set('GET /api/sessions', () => json([{ ...summary }]));
        handlers.set('POST /api/chat/regenerate', () =>
            json({ error: { code: 'SESSION_BUSY', message: 'phiên đang bận' } }, 409));
        render(<ChatInterface />);
        await screen.findByText('Chào bạn');

        fireEvent.click(await screen.findByRole('button', { name: 'Tạo lại câu trả lời' }));
        expect(await screen.findByText(/đang chạy một lượt khác/i)).not.toBeNull();
        // 409 vẫn là lỗi thật (khác 202), nên có alert — và stream không bị coi là đã bắt đầu.
        expect(countOf('POST /api/chat/stream')).toBe(0);
    });

    it('leaves no debug line when a stream closes without turn/end', async () => {
        // Transport phát `turn/end` tổng hợp với `reason: 'error'` khi response đóng sớm
        // (api.ts `endTurn('error')`) và vẫn resolve — nên không có `chat.error` nào cả.
        // Composer không còn dòng debug nào: transcript giữ hàng bền, không alert bịa thêm.
        handlers.set('POST /api/chat/stream', () => sse([
            durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
            durable('user/message', { messageId: 'u1', content: 'xin chào', source: 'user' }, 2),
            live('assistant/delta', { turnId: 't1', text: 'Chào ' }),
        ]));
        render(<ChatInterface />);
        await screen.findByText('Hôm nay bạn muốn xây gì?');

        send('xin chào');
        await waitFor(() => expect(countOf(`GET /api/sessions/${SESSION_ID}`)).toBeGreaterThan(0));
        expect(screen.queryByText(/không có tín hiệu hoàn tất/i)).toBeNull();
        expect(screen.queryByText(/hàng đã lưu/i)).toBeNull();
        // Không phải lỗi: không có alert nào được bịa thêm.
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('renders a pending approval and settles it through /api/approvals/:id', async () => {
        await openApprovalModal();

        // Ruling 1: the modal has TWO allow buttons with distinct scopes; the once-only button is
        // the one that must post `{decision:'allow', scope:'once'}`.
        fireEvent.click(screen.getByRole('button', { name: 'Cho phép một lần' }));
        await waitFor(() => expect(countOf('POST /api/approvals/ap1')).toBe(1));
        expect(bodyOf('POST /api/approvals/ap1')).toEqual({ decision: 'allow', scope: 'once' });
        // POST mới là nửa đầu: `decisionFrame` là nửa thứ hai — frame cộng mà lần reload kế tiếp cũng
        // tái tạo. Không có assert này thì một thẻ approval treo trên screen vẫn ăn pass.
        await waitFor(() => expect(screen.queryByRole('button', { name: /cho phép/i })).toBeNull());
        expect(screen.queryByText(/xin được chạy/i)).toBeNull();
    });

    it('collapses repeated approval triggers into one in-flight request', async () => {
        // NB5 (round 1) + Important (round 2): Escape auto-repeat / click đúp từng là N lần POST. Chốt
        // phải ở ChatInterface (chủ của request) chứ không ở modal, nên test này drive bằng DOM thật.
        const gate = deferred<Response>();
        handlers.set('POST /api/approvals/ap1', () => gate.promise);
        await openApprovalModal();

        fireEvent.click(screen.getByRole('button', { name: 'Cho phép một lần' }));
        // fetch ra đường ở microtask bên trong api client, không phải đồng bộ với click.
        await waitFor(() => expect(countOf('POST /api/approvals/ap1')).toBe(1));

        fireEvent.click(screen.getByRole('button', { name: 'Cho phép một lần' }));
        fireEvent.keyDown(document, { key: 'Escape' });

        // Hai trigger nữa rơi vào đúng cửa sổ request đang bay ⇒ không có POST thứ hai.
        expect(countOf('POST /api/approvals/ap1')).toBe(1);
        expect(bodyOf('POST /api/approvals/ap1')).toEqual({ decision: 'allow', scope: 'once' });

        gate.resolve(json({ ok: true, approvalId: 'ap1', decision: 'allow', scope: 'once' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: /cho phép/i })).toBeNull());
        expect(countOf('POST /api/approvals/ap1')).toBe(1);
    });

    it('lets the user retry a decision after the POST fails instead of dead-ending the dialog', async () => {
        // Chiều mà round 2 làm hỏng: modal latch nhưng `handleApproval` chỉ toast khi lỗi, thành thử
        // ba nút + Escape tê liệt tới hết `APPROVAL_TIMEOUT_MS = 120_000` của server.
        handlers.set('POST /api/approvals/ap1', () => json({ error: 'APPROVAL_NOT_FOUND' }, 409));
        await openApprovalModal();

        fireEvent.click(screen.getByRole('button', { name: 'Cho phép một lần' }));
        await waitFor(() => expect(countOf('POST /api/approvals/ap1')).toBe(1));
        // Không settle ⇒ dialog vẫn mounted, vẫn focus-trapped, người dùng còn đường ra. Từ Task 24,
        // `OnboardingModal` cũng là `role="dialog"` (bẫy focus + Esc), nên "một dialog nào đó" là assertion
        // yếu hơn cả trước đây: khoá đúng dialog CHỨA ba nút quyết định, và đúng dialog của approval.
        const approvalDialog = screen.getByRole('button', { name: 'Cho phép một lần' }).closest('[role="dialog"]');
        expect(approvalDialog).toBeInTheDocument();
        expect(approvalDialog?.getAttribute('aria-labelledby') ?? '').toMatch(/^approval-title-/);

        handlers.set('POST /api/approvals/ap1', () => json({ ok: true, approvalId: 'ap1', decision: 'allow', scope: 'once' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cho phép một lần' }));
        await waitFor(() => expect(countOf('POST /api/approvals/ap1')).toBe(2));
        await waitFor(() => expect(screen.queryByRole('button', { name: /cho phép/i })).toBeNull());
    });
});
