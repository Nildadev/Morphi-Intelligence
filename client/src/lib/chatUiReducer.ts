import type { DerivedMessage } from '../types';
import { TRANSPORT_ERROR_CODE } from './api';
import { applyStreamEvent, emptyDraft, initialChatState } from './chatReducer';
import type { ChatAction, ChatError, ChatState } from './chatReducer';
import { codeOf, serverMessageOf } from './errorCopy';

/**
 * Hai action nội bộ duy nhất mà `applyStreamEvent` không có khung SSE nào để mô tả:
 * - `session/open`: mở một phiên (projection của `GET /api/sessions/:id`); mọi state live thuộc phiên
 *   cũ nên bị bỏ hoàn toàn.
 * - `session/reload`: sau `turn/end` các hàng bền đã chốt dưới `seq` mà client không bao giờ thấy,
 *   nên chỉ một lần reload mới cho `rowSeqById` đủ để `compaction/summary` khớp hàng.
 * - `session/restore`: đưa một phiên chạy nền trở lại màn hình nguyên trạng (draft, status, lỗi),
 *   trước khi `session/reload` reconcile các hàng bền.
 */
export type ChatUiAction =
    | ChatAction
    | { type: 'session/open'; messages: DerivedMessage[]; error?: ChatError | null }
    | { type: 'session/reload'; messages: DerivedMessage[]; error?: ChatError | null; preserveDraft?: boolean }
    | { type: 'session/restore'; state: ChatState }
    | { type: 'session/undo'; messages: DerivedMessage[] };

/**
 * Wrapper quanh fold của Task 19A. `applyStreamEvent` vẫn là ĐIỂM GOM DUY NHẤT cho mọi frame SSE: hai
 * case ở đây chỉ dựng lại nguyên trạng transcript từ projection, mọi frame khác rơi vào `default` và
 * đi qua fold nguyên bản (invariant live==reload của 19A — không đụng `chatReducer.ts` ở đây).
 */
export function chatReducer(state: ChatState, action: ChatUiAction): ChatState {
    switch (action.type) {
        case 'session/open':
            return { ...initialChatState, messages: action.messages, error: action.error ?? null };
        case 'session/restore':
            return action.state;
        case 'session/reload':
            // `queued` KHÔNG được quyết bằng độ dài danh sách nữa: fold sở hữu nó, và chỉ
            // `user/message source==='steer'` mới có quyền xoá chip (danh sách dài ra vì lý do khác —
            // ví dụ hàng của một tab khác — không nghĩa là inbox đã được rút cạn).
            // `rowSeqById` phải giữ: hàng của projection không mang `seq` trên wire, nên map do live
            // fold dựng là thứ duy nhất để `compaction/summary` khớp được hàng.
            // `handoffKey` cũng phải giữ: reload chạy ngay sau `turn/end`, và nếu key đổi thì React
            // remount hàng vừa stream, cắt animation của những chữ cuối còn đang chạy.
            const handoffById = new Map(
                state.messages
                    .filter((message) => message.handoffKey !== undefined)
                    .map((message) => [message.id, message.handoffKey!] as const),
            );
            const messages = action.messages.map((message) => {
                const handoffKey = handoffById.get(message.id);
                return handoffKey === undefined ? message : { ...message, handoffKey };
            });
            return {
                ...state,
                messages,
                // A running background turn owns its draft; reloading the durable prefix must not
                // erase the text that has not settled yet. When no turn is running the draft is
                // already empty (turn/end cleared it), so preserving it is a no-op.
                ...(action.preserveDraft === true ? {} : { draft: emptyDraft() }),
                ...(action.error !== undefined ? { error: action.error } : {}),
            };
        case 'session/undo':
            // Undo replaces the transcript with the shortened projection and clears the visible
            // error for the undone turn. `rowSeqById` is preserved for compaction matching.
            return { ...state, messages: action.messages, draft: emptyDraft(), error: null, settled: null, pendingApproval: null };
        default:
            return applyStreamEvent(state, action);
    }
}

/**
 * Lỗi HTTP/transport được gom về cùng chỗ với lỗi live bằng một khung `error` tổng hợp: reducer vẫn
 * là điểm gom state duy nhất. Frame này KHÔNG phải hàng bền (không có `seq`, nên không bao giờ vào
 * `rowSeqById`) và id của nó chỉ mang tính debug.
 *
 * `message` chỉ là dòng chữ có chủ đích của server khi envelope có `error.message`; mọi code transport
 * tự phát minh mang text thô của trình duyệt ("Failed to fetch"), nên để rỗng — UI render copy theo
 * `code`, không render chuỗi tiếng Anh đó.
 */
export const errorFrameOf = (error: unknown): ChatAction => {
    const code = codeOf(error);
    return {
        id: 'evt_transport_error',
        type: 'error',
        payload: {
            code,
            message: serverMessageOf(error) ?? '',
            retryable: code === TRANSPORT_ERROR_CODE,
        },
        ts: Date.now(),
    };
};

/**
 * Frame `approval/decision` tổng hợp sau khi `POST /api/approvals/:id` thành công — chính là phép cộng
 * mà lần reload tiếp theo sẽ tái tạo. `seq: 0` chỉ là chỗ trống hình thức cho kiểu envelope: nhánh
 * reducer của `approval/decision` không đọc `seq` và không có hàng bền nào đứng sau frame này.
 */
export const decisionFrame = (approvalId: string, decision: 'allow' | 'deny'): ChatAction => ({
    id: 'evt_transport_decision',
    seq: 0,
    type: 'approval/decision',
    payload: { approvalId, decision, scope: 'once' },
    ts: Date.now(),
});
