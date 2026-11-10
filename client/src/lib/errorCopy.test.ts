import { describe, expect, it } from 'vitest';
import { ApiError, TRANSPORT_ERROR_CODE, UNEXPECTED_RESPONSE_CODE } from './api';
import { ERROR_COPY, codeOf, errorCopy, serverMessageOf } from './errorCopy';
import { vi } from '../i18n/vi';

describe('errorCopy', () => {
    it('has a Vietnamese line for every code in the table and uses it verbatim', () => {
        const codes = Object.keys(ERROR_COPY);
        expect(codes.length).toBeGreaterThan(10);
        for (const code of codes) {
            expect(errorCopy(code)).toBe(ERROR_COPY[code]);
        }
    });

    it.each([
        'VALIDATION_ERROR', 'SESSION_BUSY', 'MESSAGE_NOT_FOUND', 'SESSION_NOT_FOUND', 'PROJECT_NOT_FOUND',
        'NO_PROVIDER', 'UNAUTHORIZED', 'NOT_FOUND', 'INTERNAL_ERROR',
    ])('covers the route-level code %s', (code) => {
        expect(ERROR_COPY[code]).toBeTruthy();
    });

    it.each([
        'TURN_TIMEOUT', 'CONTEXT_TRIMMED', 'CONTEXT_OVERFLOW', 'TOO_MANY_TOOL_CALLS', 'AGENT_ERROR',
    ])('covers the live error-frame code %s', (code) => {
        expect(ERROR_COPY[code]).toBeTruthy();
    });

    it('never guesses through a message string: a truly unknown code still gets a deterministic line', () => {
        expect(errorCopy('SOMETHING_NEW')).toBe('Lỗi SOMETHING_NEW.');
    });

    it.each([
        'API_KEY_NOT_ACCEPTED', 'APPROVAL_NOT_FOUND', 'TOOL_NOT_FOUND', 'UNKNOWN_PROVIDER', 'MCP_PATH_REJECTED',
        // Task 31C: every Studio failure mode a user can actually hit has a Vietnamese fix.
        'STUDIO_NOT_CONNECTED', 'MULTIPLE_STUDIOS', 'MCP_SPAWN_FAILED', 'MCP_TOOL_TIMEOUT',
        'STUDIO_RESTART_REQUIRED', 'MCP_TOOL_FAILED',
    ])('gives real Vietnamese copy for %s instead of leaking the English fallback', (code) => {
        // Ruling P20-5: Task 19 để năm code này rơi vào `Lỗi <code>.`. Giờ chúng sống trong `vi.errors`
        // và được gộp vào `ERROR_COPY`, nên `errorCopy` không còn trả fallback cho chúng.
        expect(ERROR_COPY[code]).toBeTruthy();
        expect(errorCopy(code)).toBe(ERROR_COPY[code]);
        expect(errorCopy(code)).not.toBe(`Lỗi ${code}.`);
    });

    it('renders the HTTP_<status> branch the transport invents when no envelope exists', () => {
        expect(errorCopy('HTTP_502')).toBe('Server harness trả về lỗi HTTP 502.');
        expect(errorCopy('HTTP_418')).toBe('Server harness trả về lỗi HTTP 418.');
    });

    it('reads the code off ApiError and treats everything else as transport', () => {
        expect(codeOf(new ApiError(409, 'SESSION_BUSY'))).toBe('SESSION_BUSY');
        expect(codeOf(new TypeError('Failed to fetch'))).toBe(TRANSPORT_ERROR_CODE);
        expect(codeOf('boom')).toBe(TRANSPORT_ERROR_CODE);
        expect(codeOf(undefined)).toBe(TRANSPORT_ERROR_CODE);
    });
});

/**
 * I4 (round 3): copy không được hứa cái nút mà người dùng không bao giờ bấm được.
 *
 * `ErrorCard.showRetry` cần `error.retryable !== false` VÀ `onRetry !== undefined`. Hai chiều đó KHÔNG
 * đối xứng, và round 3 từng viết sai bằng cách gộp chúng thành "nút chết":
 * - **Phía server: nút không bao giờ hiện.** Bốn khung `error` client-visible — `loop.ts:245`
 *   (turn-terminal), `loop.ts:279`/`313` (step-level), `routes/chat.ts:110` (AGENT_ERROR) — đều mang
 *   `retryable: false`, và `chatReducer.ts:396` copy nguyên vẹn payload. Cái hay gặp nhất là
 *   `loop.ts:246`: nó ghi thẳng chữ `false`, **không đọc** `outcome.error.retryable`, nên một 429/5xx mà
 *   adapter đã đánh giá retry được (`retry.ts:93` trả failure nguyên trạng khi hết budget) vẫn xuống dây
 *   với nút bị ẩn. `loop.ts:408` là chỗ khác: nó tổng hợp `stream_error` `false` khi một `finish` frame
 *   tới với `reason: 'error'` mà chưa có failure trước đó.
 * - **Phía transport: nút sống.** `chatUiReducer.ts:57` tự dựng khung `error` với
 *   `retryable: code === TRANSPORT_ERROR_CODE` — server không reachable thì `true` — và `ChatInterface.tsx:243`
 *   dispatch nó khi `start()` throw. `ChatView.tsx:50-55` cung cấp `onRetry` khi lượt không chạy. Chuỗi
 *   đó đã được pin: `chatUiReducer.test.ts:85-92` (retryable `true` cho `TypeError`),
 *   `ErrorCard.test.tsx:52-63` và `ChatView.test.tsx:85-98` (nút hiện, bấm được, và ẩn khi
 *   `retryable: false` hoặc thiếu `onRetry`).
 *
 * ⇒ Luật cấm **copy hứa**, không cấm control: với code phía server thì "thử lại" là hứa suông, còn code
 * transport thì bảng copy lại đang *dưới hứa* (`TRANSPORT_ERROR` không mời bấm lại dù nút có hiện) — hướng
 * an toàn và §6.6.2 cho phép. Luật viết thành hàm để mutant của chính copy bị bắt, chứ không phải một
 * danh sách key đã kiểm tra tay.
 */
describe('no error copy promises a retry that its own wire path never raises', () => {
    const retryWord = vi.chat.retry.toLowerCase();

    const offenders = (table: Record<string, string>): string[] =>
        Object.entries(table).filter(([, copy]) => copy.toLowerCase().includes(retryWord)).map(([code]) => code);

    it('catches a seeded promise instead of always returning []', () => {
        // Mutation control: nếu `offenders` hỏng (so sánh sai, sai case-fold) thì assert cuối cùng dưới
        // đây sẽ xanh mà không đọc gì. Nút "Thử lại" là nhãn THẬT (`vi.chat.retry`), nên một copy chứa nó
        // là vi phạm — kể cả viết hoa/viết thường.
        expect(offenders({ SOME_CODE: `Hãy ${retryWord} sau.` })).toEqual(['SOME_CODE']);
        expect(offenders({ SOME_CODE: `${vi.chat.retry}.` })).toEqual(['SOME_CODE']);
    });

    it('names the three copies that used to break the rule', () => {
        // Bảng giả mà lấy lại copy round 2: cả ba đều bị bắt. Đây là bằng chứng luật có răng đúng trên
        // các defect nó sinh ra, không chỉ trên mutant tổng quát.
        expect(offenders({
            http_error: 'Nhà cung cấp trả về lỗi HTTP. Kiểm tra API key và model, thử lại sau.',
            TURN_TIMEOUT: 'Lượt trả lời vượt quá thời gian cho phép. Hãy thử lại với yêu cầu gọn hơn.',
            TOO_MANY_TOOL_CALLS: 'Quá nhiều lời gọi tool trong một lượt. Hãy thử lại.',
        })).toEqual(['http_error', 'TURN_TIMEOUT', 'TOO_MANY_TOOL_CALLS']);
    });

    it('ships zero retry-promising copy across the whole table', () => {
        expect(offenders(ERROR_COPY)).toEqual([]);
    });

    it('describes the rate-limit branch instead of blaming the key (Task 24)', () => {
        // Copy cũ ("Nhà cung cấp trả về lỗi HTTP. Kiểm tra API key và model đã chọn.") là một lời hứa
        // SAI với 429: key vẫn đúng, chỉ bị chặn tần suất, nên bảo người dùng đi soi key là lạc hướng.
        // Hai mệnh đề dưới đây là hai nhánh mà `retry.ts:35` + adapter thật sự tách ra (429/≥500 vs 4xx);
        // đảo lại copy cũ thì dòng đầu đỏ — assert có răng, không phải chữ trang trí.
        expect(errorCopy('http_error')).toMatch(/giới hạn tần suất/i);
        expect(errorCopy('http_error')).toMatch(/Cài đặt/);
    });

    it('keeps the retry label itself reachable only through ErrorCard, not through copy', () => {
        // `vi.chat.retry` vẫn tồn tại vì ErrorCard còn nhánh `showRetry`; luật cấm COPY hứa, không cấm
        // nhãn của control. Assert này giữ cho người refactor không "dọn" luôn nhãn rồi làm ErrorCard đỏ.
        expect(vi.chat.retry).toBe('Thử lại');
        expect(ERROR_COPY[vi.chat.retry]).toBeUndefined();
    });
});

describe('serverMessageOf', () => {
    it('keeps a message the server wrote on purpose', () => {
        expect(serverMessageOf(new ApiError(409, 'SESSION_BUSY', 'phiên đang bận'))).toBe('phiên đang bận');
    });

    it('drops the `message ?? code` fallback so the code never renders twice', () => {
        expect(serverMessageOf(new ApiError(404, 'NOT_FOUND'))).toBeUndefined();
    });

    it('blocks raw browser/transport text from reaching a Vietnamese UI', () => {
        expect(serverMessageOf(new ApiError(0, TRANSPORT_ERROR_CODE, 'Failed to fetch'))).toBeUndefined();
        expect(serverMessageOf(new ApiError(200, UNEXPECTED_RESPONSE_CODE, 'expected an event-stream response'))).toBeUndefined();
        expect(serverMessageOf(new ApiError(500, 'HTTP_500', 'Internal Server Error'))).toBeUndefined();
        expect(serverMessageOf(new TypeError('boom'))).toBeUndefined();
    });
});
