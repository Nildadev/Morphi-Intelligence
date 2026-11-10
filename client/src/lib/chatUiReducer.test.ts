import { describe, expect, it } from 'vitest';
import { ApiError, TRANSPORT_ERROR_CODE } from './api';
import { applyStreamEvent, emptyDraft, initialChatState } from './chatReducer';
import type { ChatAction, ChatState } from './chatReducer';
import { chatReducer, decisionFrame, errorFrameOf } from './chatUiReducer';
import type { DerivedMessage } from '../types';

const row = (id: string, content: string): DerivedMessage => ({
    id, role: 'assistant', content, steps: [{ type: 'text', content }], createdAt: 1, superseded: false,
});

/**
 * State giữa một lượt — mọi field wrapper `session/*` có thể đụng tới đều mang giá trị phân biệt được,
 * để một lần reset/quay sai là assert thấy ngay.
 */
const midTurn: ChatState = {
    ...initialChatState,
    messages: [row('a1', 'câu cũ')],
    draft: { turnId: 't1', key: 'live_1', content: 'nửa câu', reasoning: '', steps: [] },
    status: 'thinking',
    error: { code: 'NO_PROVIDER' },
    title: 'Tiêu đề live',
    queued: { messages: ['steer đang chờ'], position: 2 },
    toolProgress: { c1: 'read_file running' },
    settled: 'cancelled',
    rowSeqById: { a1: 7 },
};

const DELTA: ChatAction = { id: 'live_1', type: 'assistant/delta', payload: { turnId: 't1', text: ' thêm' }, ts: 5 };

describe('chatReducer wrapper', () => {
    it('delegates every SSE frame to `applyStreamEvent` unchanged', () => {
        // Invariant của Task 19A: wrapper không được có đường tắt nào cho frame thật.
        expect(chatReducer(midTurn, DELTA)).toEqual(applyStreamEvent(midTurn, DELTA));
        expect(chatReducer(midTurn, { type: 'transport/queued', payload: { position: 3 } })).toEqual(
            applyStreamEvent(midTurn, { type: 'transport/queued', payload: { position: 3 } }),
        );
    });

    it('session/open drops every piece of live state of the previous session', () => {
        const next = chatReducer(midTurn, { type: 'session/open', messages: [row('b1', 'phiên khác')] });
        expect(next).toEqual({ ...initialChatState, messages: [row('b1', 'phiên khác')] });
        expect(next.rowSeqById).toEqual({});
        expect(next.title).toBeNull();
        expect(next.error).toBeNull();
        expect(next.settled).toBeNull();
        expect(next.queued).toBeNull();
    });

    it('session/reload keeps the seq map and the turn facts, and clears only the draft', () => {
        const next = chatReducer(midTurn, { type: 'session/reload', messages: [row('a1', 'câu cũ'), row('a2', 'hàng bền mới')] });
        // Hàng của projection không mang `seq` trên wire: map do live fold dựng là thứ duy nhất để
        // `compaction/summary` khớp được hàng, nên nó phải còn nguyên.
        expect(next.rowSeqById).toEqual({ a1: 7 });
        expect(next.draft).toEqual(initialChatState.draft);
        expect(next.messages.map(m => m.id)).toEqual(['a1', 'a2']);
        expect(next.settled).toBe('cancelled');
        expect(next.error).toEqual({ code: 'NO_PROVIDER' });
        expect(next.title).toBe('Tiêu đề live');
    });

    it('session/reload leaves `queued` to the fold instead of guessing from list length', () => {
        // Trước đây wrapper quyết `queued` bằng `messages.length > state.messages.length`, tức là một
        // hàng đến từ nơi khác (tab khác ghi `assistant/message`) cũng xoá chip "đang xếp hàng" — trong
        // khi steer vẫn còn trong inbox. Chỉ `user/message source==='steer'` (fold) mới có quyền đó.
        const longer = chatReducer(midTurn, { type: 'session/reload', messages: [row('a1', 'câu cũ'), row('a2', 'nhiều hơn')] });
        expect(longer.queued).toEqual({ messages: ['steer đang chờ'], position: 2 });
        const same = chatReducer(midTurn, { type: 'session/reload', messages: midTurn.messages });
        expect(same.queued).toEqual({ messages: ['steer đang chờ'], position: 2 });
        const folded = applyStreamEvent(longer, {
            id: 'evt_9', seq: 9, type: 'user/message', ts: 9,
            payload: { messageId: 'u9', content: 'steer', source: 'steer' },
        });
        expect(folded.queued).toBeNull();
    });

    it('hands the live draft key to the durable row and keeps it across reload', () => {
        // The draft row and the durable row must share one React key, otherwise `assistant/message`
        // remounts the markdown and kills word animations that are still running.
        const live = { ...initialChatState, draft: emptyDraft('t1', 'live_7') };
        const withText = applyStreamEvent(live, DELTA);
        const durable = applyStreamEvent(withText, {
            id: 'live_9', seq: 9, type: 'assistant/message', ts: 9,
            payload: {
                messageId: 'a9', content: ' nửa câu thêm', finishReason: 'stop', callIds: [],
            },
        });
        expect(durable.messages[0]?.handoffKey).toBe('live_7');
        expect(durable.draft).toEqual(emptyDraft());

        const reloaded = chatReducer(durable, { type: 'session/reload', messages: [row('a9', ' nửa câu thêm')] });
        expect(reloaded.messages[0]?.handoffKey).toBe('live_7');
        // A projection that never saw the live frame simply keeps its own id as the key.
        const cold = chatReducer(initialChatState, { type: 'session/reload', messages: [row('a9', 'cũ')] });
        expect(cold.messages[0]?.handoffKey).toBeUndefined();
    });
});

describe('errorFrameOf', () => {
    it('carries the code and keeps a message the server wrote on purpose', () => {
        const frame = errorFrameOf(new ApiError(409, 'SESSION_BUSY', 'phiên đang bận'));
        expect(frame.type).toBe('error');
        expect(frame.payload).toEqual({ code: 'SESSION_BUSY', message: 'phiên đang bận', retryable: false });
    });

    it('suppresses raw browser text for transport codes', () => {
        const frame = errorFrameOf(new TypeError('Failed to fetch'));
        expect(frame.type).toBe('error');
        expect(frame.payload).toEqual({ code: TRANSPORT_ERROR_CODE, message: '', retryable: true });
        // ...và fold vẫn ra đúng `state.error`, UI chỉ còn thấy copy theo code.
        const next = chatReducer(midTurn, frame);
        expect(next.error).toEqual({ code: TRANSPORT_ERROR_CODE, message: '', retryable: true });
    });

    it('is not a durable row: no seq, so it can never poison `rowSeqById`', () => {
        const frame = errorFrameOf(new ApiError(500, 'INTERNAL_ERROR'));
        expect('seq' in frame ? frame.seq : undefined).toBeUndefined();
        const next = chatReducer(midTurn, frame);
        expect(next.rowSeqById).toEqual({ a1: 7 });
        expect(next.messages).toEqual(midTurn.messages);
    });
});

describe('decisionFrame', () => {
    it('is the additive frame the next reload will reproduce', () => {
        const frame = decisionFrame('ap1', 'allow');
        expect(frame).toMatchObject({
            type: 'approval/decision',
            payload: { approvalId: 'ap1', decision: 'allow', scope: 'once' },
        });
        // `seq: 0` chỉ là chỗ trống hình thức cho kiểu envelope — nhánh reducer không đọc `seq`.
        const pending: ChatState = {
            ...midTurn,
            pendingApproval: {
                approvalId: 'ap1', callId: 'c1', name: 'run_command', args: {}, risk: 'high', turnId: 't1',
            },
        };
        const next = chatReducer(pending, frame);
        expect(next.pendingApproval).toBeNull();
        expect(next.rowSeqById).toEqual({ a1: 7 });
    });
});
