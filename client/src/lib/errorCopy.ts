import { ApiError, TRANSPORT_ERROR_CODE, UNEXPECTED_RESPONSE_CODE } from './api';
import { vi } from '../i18n/vi';

/**
 * Copy tiếng Việt theo `error.code` — không bao giờ đoán qua chuỗi message.
 *
 * `code` là `error.code` của envelope thống nhất nhất (`server/src/http/validation.ts`) hoặc một code
 * mà transport tự phát minh (`TRANSPORT_ERROR`/`UNEXPECTED_RESPONSE`/`HTTP_<status>`), nên bảng này là
 * chỗ duy nhất quyết định "người dùng thấy gì khi lỗi". Năm code Task 19 bỏ tiếng Anh
 * (`API_KEY_NOT_ACCEPTED`/`APPROVAL_NOT_FOUND`/`TOOL_NOT_FOUND`/`UNKNOWN_PROVIDER`/`MCP_PATH_REJECTED`)
 * lấy từ `vi.errors` (Ruling P20-5); phần còn lại vẫn là bảng riêng của transport copy.
 */
export const ERROR_COPY: Record<string, string> = {
    SESSION_BUSY: 'Phiên đang chạy một lượt khác — tin nhắn của bạn sẽ được bổ trợ vào lượt đó.',
    NO_PROVIDER: 'Chưa cấu hình provider nào. Mở Cài đặt để thêm API key cho một provider.',
    TURN_TIMEOUT: 'Lượt trả lời vượt quá 10 phút nên đã dừng. Hãy rút gọn yêu cầu rồi gửi tin nhắn mới.',
    CONTEXT_TRIMMED: 'Ngữ cảnh đã được cắt bớt để vừa cửa sổ model.',
    CONTEXT_OVERFLOW: 'Hội thoại đã vượt quá cửa sổ ngữ cảnh của model. Hãy bắt đầu phiên mới.',
    TOO_MANY_TOOL_CALLS: 'Một bước chỉ chạy tối đa 8 lời gọi tool, phần còn lại bị bỏ qua.',
    AGENT_ERROR: 'Agent gặp lỗi khi chạy lượt này.',
    UNAUTHORIZED: 'Không xác thực được với server harness (token không hợp lệ).',
    NOT_FOUND: 'Không tìm thấy tài nguyên được yêu cầu.',
    SESSION_NOT_FOUND: 'Phiên này không còn tồn tại trên server.',
    MESSAGE_NOT_FOUND: 'Tin nhắn cần regenerate không còn tồn tại.',
    PROJECT_NOT_FOUND: 'Project này không còn tồn tại trên server.',
    VALIDATION_ERROR: 'Yêu cầu không hợp lệ.',
    INTERNAL_ERROR: 'Server harness gặp lỗi nội bộ.',
    // Raised by `server/src/http/errors.ts` before any route runs: the body arrived but could not be read.
    // Without a line here a client bug (a payload built from a stale shape) surfaced as `Lỗi INVALID_JSON.`
    INVALID_JSON: 'Dữ liệu gửi lên không phải JSON hợp lệ.',
    PAYLOAD_TOO_LARGE: 'Dữ liệu gửi lên quá lớn.',
    UNSUPPORTED_ENCODING: 'Định dạng dữ liệu gửi lên không được hỗ trợ.',
    REQUEST_ABORTED: 'Yêu cầu đã bị huỷ trước khi server đọc xong.',
    BAD_REQUEST: 'Yêu cầu không hợp lệ.',
    TRANSPORT_ERROR: 'Không kết nối được tới server harness. Hãy chạy `npm run dev` ở thư mục server.',
    // Ruling P20-5: năm code này tập trung trong `vi.errors`, không còn rơi vào fallback `Lỗi <code>.`.
    ...vi.errors,
};

/** Codes invented by the transport: no server envelope behind them, so their `message` is raw wire text. */
const isInventedCode = (code: string): boolean =>
    code === TRANSPORT_ERROR_CODE
        || code === UNEXPECTED_RESPONSE_CODE
        || /^HTTP_\d+$/.test(code);

export const errorCopy = (code: string): string =>
    ERROR_COPY[code] ?? (code.startsWith('HTTP_')
        ? `Server harness trả về lỗi HTTP ${code.slice(5)}.`
        : `Lỗi ${code}.`);

export const codeOf = (error: unknown): string =>
    (error instanceof ApiError ? error.code : TRANSPORT_ERROR_CODE);

/**
 * `ApiError` được dựng từ envelope thì `message` là dòng chữ có chủ đích của server (tiếng Việt);
 * `super(message ?? code)` nghĩa là `message === code` khi envelope không có message, còn các code
 * transport tự phát minh mang text thô của trình duyệt ("Failed to fetch"). Chỉ hai trường đầu tiên
 * được phép vào UI; phần còn lại để copy theo `code` lo.
 */
export const serverMessageOf = (error: unknown): string | undefined => {
    if (!(error instanceof ApiError)) return undefined;
    if (isInventedCode(error.code)) return undefined;
    // `super(message ?? code)`: không có envelope message thì message CHỈ là code — hiển thị nó là in
    // code hai lần.
    return error.message === error.code ? undefined : error.message;
};
