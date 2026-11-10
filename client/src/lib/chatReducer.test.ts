import { describe, expect, it } from 'vitest';
import { applyStreamEvent, initialChatState } from './chatReducer';
import type { ChatState } from './chatReducer';
import type { StreamEnvelope } from '../types';

/** Feeds frames in wire order from `state`, so tests assert real transitions. */
function play2(state: ChatState, ...frames: StreamEnvelope[]) {
  return frames.reduce((current, frame) => applyStreamEvent(current, frame), state);
}

function play(...frames: StreamEnvelope[]) {
  return play2(initialChatState, ...frames);
}

/**
 * One tool-bearing turn in the order the server really emits it, transcribed from the emit sites
 * (`routes/chat.test.ts:350-372` proves these frames exist but never lists them in order):
 *   loop.ts:190 turn/start → :201 user/message → :206 agent/status thinking → :272 step/start
 *   → :376 assistant/delta → :297-307 assistant/message (`callIds` at :305) → :322 agent/status tool
 *   → pipeline.ts:214-217 tool/call → tool/result on the settle → loop.ts:443-452 the synthetic live
 *   tool/progress carrying the terminal line → :265 agent/status thinking → :272 step/start
 *   → :297 assistant/message → :241 turn/end → :249 agent/status idle.
 * The pre-result `tool/progress` line is the tool's own live frame (`ctx.emit.live`), which a
 * long-running tool may or may not send.
 */
const TOOL_TURN: StreamEnvelope[] = [
  { id: 'evt_1', seq: 1, type: 'turn/start', ts: 100, payload: { turnId: 't1', modelSelection: 'gemini', trigger: 'user' } },
  { id: 'evt_2', seq: 2, type: 'user/message', ts: 101, payload: { messageId: 'u1', content: 'đọc file giúp mình', source: 'user' } },
  { id: 'live_1', type: 'agent/status', ts: 102, payload: { state: 'thinking', turnId: 't1' } },
  { id: 'evt_3', seq: 3, type: 'step/start', ts: 103, payload: { stepId: 'st_0', index: 0 } },
  { id: 'live_2', type: 'assistant/delta', ts: 104, payload: { turnId: 't1', text: 'để tôi đọc' } },
  { id: 'evt_4', seq: 4, type: 'assistant/message', ts: 105, payload: { messageId: 'a1', content: 'để tôi đọc', finishReason: 'tool_calls', callIds: ['c1'] } },
  { id: 'live_3', type: 'agent/status', ts: 106, payload: { state: 'tool', turnId: 't1' } },
  { id: 'evt_5', seq: 5, type: 'tool/call', ts: 107, payload: { callId: 'c1', name: 'read_file', args: { path: 'a.ts' }, startedAt: 107 } },
  { id: 'live_4', type: 'tool/progress', ts: 108, payload: { callId: 'c1', message: 'read_file running' } },
  { id: 'evt_6', seq: 6, type: 'tool/result', ts: 109, payload: { callId: 'c1', status: 'done', result: 'contents', durationMs: 12 } },
  { id: 'live_5', type: 'tool/progress', ts: 110, payload: { callId: 'c1', message: 'read_file completed' } },
  { id: 'live_6', type: 'agent/status', ts: 111, payload: { state: 'thinking', turnId: 't1' } },
  { id: 'evt_7', seq: 7, type: 'step/start', ts: 112, payload: { stepId: 'st_1', index: 1 } },
  { id: 'live_7', type: 'assistant/delta', ts: 113, payload: { turnId: 't1', text: 'xong rồi' } },
  { id: 'evt_8', seq: 8, type: 'assistant/message', ts: 114, payload: { messageId: 'a2', content: 'xong rồi', finishReason: 'stop', callIds: [] } },
  { id: 'evt_9', seq: 9, type: 'turn/end', ts: 115, payload: { turnId: 't1', reason: 'completed' } },
  { id: 'live_8', type: 'agent/status', ts: 116, payload: { state: 'idle', turnId: 't1' } },
];

/**
 * The same step with an `ask` tool: `approval.ts:64-71` writes approval/request then the
 * `waiting_approval` status, `POST /api/approvals/:id` writes approval/decision (approval.ts:89),
 * `loop.ts:438-441` re-opens the `tool` status, and only then does the call settle.
 */
const APPROVAL_TURN: StreamEnvelope[] = [
  { id: 'evt_1', seq: 1, type: 'turn/start', ts: 200, payload: { turnId: 't1', modelSelection: 'gemini', trigger: 'user' } },
  { id: 'evt_2', seq: 2, type: 'user/message', ts: 201, payload: { messageId: 'u1', content: 'tạo một part', source: 'user' } },
  { id: 'live_1', type: 'agent/status', ts: 202, payload: { state: 'thinking', turnId: 't1' } },
  { id: 'evt_3', seq: 3, type: 'step/start', ts: 203, payload: { stepId: 'st_0', index: 0 } },
  { id: 'evt_4', seq: 4, type: 'assistant/message', ts: 204, payload: { messageId: 'a1', content: 'Tạo một part', finishReason: 'tool_calls', callIds: ['c1'] } },
  { id: 'live_2', type: 'agent/status', ts: 205, payload: { state: 'tool', turnId: 't1' } },
  { id: 'evt_5', seq: 5, type: 'tool/call', ts: 206, payload: { callId: 'c1', name: 'spawn_part', args: { name: 'Baseplate' }, startedAt: 206 } },
  { id: 'evt_6', seq: 6, type: 'approval/request', ts: 207, payload: { approvalId: 'ap_1', callId: 'c1', name: 'spawn_part', args: { name: 'Baseplate' }, risk: 'medium' } },
  { id: 'live_3', type: 'agent/status', ts: 208, payload: { state: 'waiting_approval', turnId: 't1' } },
  { id: 'evt_7', seq: 7, type: 'approval/decision', ts: 209, payload: { approvalId: 'ap_1', decision: 'allow', scope: 'once' } },
  { id: 'live_4', type: 'agent/status', ts: 210, payload: { state: 'tool', turnId: 't1' } },
  { id: 'evt_8', seq: 8, type: 'tool/result', ts: 211, payload: { callId: 'c1', status: 'done', result: { ok: true }, durationMs: 5 } },
  { id: 'live_5', type: 'tool/progress', ts: 212, payload: { callId: 'c1', message: 'spawn_part completed' } },
  { id: 'live_6', type: 'agent/status', ts: 213, payload: { state: 'thinking', turnId: 't1' } },
  { id: 'evt_9', seq: 9, type: 'step/start', ts: 214, payload: { stepId: 'st_1', index: 1 } },
  { id: 'evt_10', seq: 10, type: 'assistant/message', ts: 215, payload: { messageId: 'a2', content: 'Xong.', finishReason: 'stop', callIds: [] } },
  { id: 'evt_11', seq: 11, type: 'turn/end', ts: 216, payload: { turnId: 't1', reason: 'completed' } },
  { id: 'live_7', type: 'agent/status', ts: 217, payload: { state: 'idle', turnId: 't1' } },
];

describe('chatReducer', () => {
  it('appends assistant deltas to the draft', () => {
    const state = applyStreamEvent(initialChatState, {
      id: 'e1', type: 'assistant/delta', payload: { turnId: 't1', text: 'Hello' }, ts: 1,
    });
    expect(state.draft.content).toBe('Hello');

    const after = applyStreamEvent(state, {
      id: 'e2', type: 'assistant/delta', payload: { turnId: 't1', text: ' world' }, ts: 2,
    });
    expect(after.draft.content).toBe('Hello world');
    expect(after.messages).toEqual([]);
  });

  it('appends thought deltas to the draft reasoning', () => {
    const state = play(
      { id: 'e1', type: 'thought/delta', payload: { turnId: 't1', text: 'thinking' }, ts: 1 },
      { id: 'e2', type: 'thought/delta', payload: { turnId: 't1', text: '…hard' }, ts: 2 },
    );
    expect(state.draft.reasoning).toBe('thinking…hard');
    expect(state.draft.content).toBe('');
  });

  it('starts a fresh draft when the turn id changes', () => {
    const state = play(
      { id: 'e1', type: 'assistant/delta', payload: { turnId: 't1', text: 'first' }, ts: 1 },
      { id: 'e2', type: 'assistant/delta', payload: { turnId: 't2', text: 'second' }, ts: 2 },
    );
    expect(state.draft).toMatchObject({ turnId: 't2', content: 'second' });
  });

  it('keeps the provisional draft out of durable messages after a failed attempt', () => {
    // The retry re-streams under the same turnId with replayed deltas suppressed; the partial from
    // the failed attempt only ever lived in the draft, so the durable row must replace it.
    const state = play(
      { id: 'e1', type: 'assistant/delta', payload: { turnId: 't1', text: 'partial' }, ts: 1 },
      { id: 'e2', type: 'error', payload: { code: 'AGENT_ERROR', message: 'boom', retryable: true }, ts: 2 },
      { id: 'e3', type: 'assistant/delta', payload: { turnId: 't1', text: ' still' }, ts: 3 },
      {
        id: 'evt_9', seq: 9, type: 'assistant/message', ts: 4,
        payload: { messageId: 'm1', content: 'final answer', finishReason: 'stop', callIds: [] },
      },
    );
    expect(state.draft.content).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: 'm1', content: 'final answer' });
  });

  it('surfaces a structured error and keeps the code distinct', () => {
    const timeout = applyStreamEvent(initialChatState, {
      id: 'e1', type: 'error', payload: { code: 'TURN_TIMEOUT', message: 'hết thời gian', retryable: false }, ts: 1,
    });
    expect(timeout.error).toEqual({ code: 'TURN_TIMEOUT', message: 'hết thời gian', retryable: false });
    expect(timeout.messages).toEqual([]);

    const overflow = applyStreamEvent(initialChatState, {
      id: 'e2', type: 'error', payload: { code: 'CONTEXT_OVERFLOW', message: 'dài quá', retryable: false }, ts: 2,
    });
    expect(overflow.error?.code).toBe('CONTEXT_OVERFLOW');
    expect(overflow.error?.code).not.toBe(timeout.error?.code);

    const trimmed = applyStreamEvent(initialChatState, {
      id: 'e3', type: 'error', payload: { code: 'CONTEXT_TRIMMED', message: 'đã cắt ngữ cảnh', retryable: true }, ts: 3,
    });
    expect(trimmed.error?.code).toBe('CONTEXT_TRIMMED');
  });

  it('sets the status from agent/status frames', () => {
    const state = play(
      { id: 'e1', type: 'agent/status', payload: { state: 'thinking', turnId: 't1' }, ts: 1 },
      { id: 'e2', type: 'agent/status', payload: { state: 'tool' }, ts: 2 },
      { id: 'e3', type: 'agent/status', payload: { state: 'waiting_approval' }, ts: 3 },
    );
    expect(state.status).toBe('waiting_approval');
  });

  it('appends a user message once, however many times the event is replayed', () => {
    const frame: StreamEnvelope = {
      id: 'evt_1', seq: 1, type: 'user/message', ts: 1,
      payload: { messageId: 'u1', content: 'câu hỏi', source: 'user' },
    };
    const state = play(frame, frame);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: 'u1', role: 'user', content: 'câu hỏi', steps: [] });

    const other = play(frame, {
      id: 'evt_2', seq: 2, type: 'user/message', ts: 2,
      payload: { messageId: 'u2', content: 'khác', source: 'user' },
    });
    expect(other.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('replaces an already-present durable message instead of appending a copy', () => {
    const userFrame: StreamEnvelope = {
      id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u1', content: 'hi', source: 'user' },
    };
    const assistantFrame: StreamEnvelope = {
      id: 'evt_2', seq: 2, type: 'assistant/message', ts: 2,
      payload: { messageId: 'a1', content: 'xin chào', reasoning: 'suy nghĩ', finishReason: 'stop', callIds: [] },
    };
    const state = play(userFrame, assistantFrame, { ...assistantFrame, id: 'evt_9', seq: 9 });
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(state.messages[1]).toMatchObject({ content: 'xin chào', reasoning: 'suy nghĩ', superseded: false });
  });

  it('ends a real tool turn with the same message/step structure the projection produces', () => {
    // deriveMessages over these same rows: u1 has no step, a1 gets the text step (projections.ts:34)
    // then the call step pushed onto IT (projections.ts:41), a2 gets only its own text step.
    const state = play(...TOOL_TURN);
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a2']);
    expect(state.messages[0].steps).toEqual([]);
    expect(state.messages[1].steps).toEqual([
      { type: 'text', content: 'để tôi đọc' },
      { type: 'call', call: { callId: 'c1', name: 'read_file', args: { path: 'a.ts' }, status: 'done', result: 'contents', durationMs: 12 } },
    ]);
    expect(state.messages[2].steps).toEqual([{ type: 'text', content: 'xong rồi' }]);
    expect(state.draft).toEqual(initialChatState.draft);
    expect(state.toolProgress).toEqual({});
    expect(state.settled).toBe('completed');
    expect(state.status).toBe('idle');
  });

  it('patches the already-persisted assistant row when a tool call lands mid-turn', () => {
    // loop.ts:297 writes the row BEFORE pipeline.ts:214 emits the call, so the call has an owner
    // already on screen: the message whose `callIds` carry it (loop.ts:305) is the message that shows it.
    const state = play(...TOOL_TURN.slice(0, 9));
    expect(state.messages.find((m) => m.id === 'a1')?.steps).toEqual([
      { type: 'text', content: 'để tôi đọc' },
      { type: 'call', call: { callId: 'c1', name: 'read_file', args: { path: 'a.ts' }, status: 'running' } },
    ]);
    expect(state.draft.steps).toEqual([]);
    expect(state.toolProgress).toEqual({ c1: 'read_file running' });
  });

  it('keeps the progress frame that arrives after the result as the terminal line', () => {
    // loop.ts:443-452 emits `tool/result` first and the synthetic terminal `tool/progress` second, so
    // the settled call must keep its line (the map is per-turn, cleared at turn/end).
    const midTurn = play(...TOOL_TURN.slice(0, 11));
    expect(midTurn.toolProgress).toEqual({ c1: 'read_file completed' });
    expect(play(...TOOL_TURN.slice(0, 15)).toolProgress).toEqual({ c1: 'read_file completed' });
    expect(play(...TOOL_TURN).toolProgress).toEqual({});
  });

  it('patches the durable row that carries a late or replayed result', () => {
    const state = play(...TOOL_TURN, {
      id: 'evt_10', seq: 10, type: 'tool/result', ts: 120,
      payload: { callId: 'c1', status: 'done', result: 'refreshed', durationMs: 15 },
    });
    expect(state.messages[1].steps[1]).toEqual({
      type: 'call', call: { callId: 'c1', name: 'read_file', args: { path: 'a.ts' }, status: 'done', result: 'refreshed', durationMs: 15 },
    });
    expect(state.messages[2].steps).toEqual([{ type: 'text', content: 'xong rồi' }]);
  });

  it('holds a call on the draft only when no durable row can own it', () => {
    // Not the server's order (the row always precedes the call) — the fallback for a log whose first
    // assistant row has not landed yet; it folds into the row that finally does.
    const state = play(
      { id: 'live_1', type: 'agent/status', ts: 1, payload: { state: 'thinking', turnId: 't1' } },
      { id: 'evt_1', seq: 1, type: 'tool/call', ts: 2, payload: { callId: 'c1', name: 'bash', args: {}, startedAt: 2 } },
    );
    expect(state.draft.steps).toEqual([
      { type: 'call', call: { callId: 'c1', name: 'bash', args: {}, status: 'running' } },
    ]);

    const settled = play2(state, {
      id: 'evt_2', seq: 2, type: 'assistant/message', ts: 3,
      payload: { messageId: 'a1', content: 'chạy xong', finishReason: 'stop', callIds: ['c1'] },
    });
    expect(settled.draft.steps).toEqual([]);
    expect(settled.messages[0].steps).toEqual([
      { type: 'text', content: 'chạy xong' },
      { type: 'call', call: { callId: 'c1', name: 'bash', args: {}, status: 'running' } },
    ]);
  });

  it('attaches an approval step to the row that requested it and settles it on decision', () => {
    // projections.ts:46-50 pushes the approval onto the current message and mutates it in place on
    // decision (:51-54), so live must do the same or the timeline card only appears after a reload.
    const waiting = play(...APPROVAL_TURN.slice(0, 9));
    expect(waiting.pendingApproval).toMatchObject({ approvalId: 'ap_1', callId: 'c1', turnId: 't1' });
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.messages.find((m) => m.id === 'a1')?.steps).toEqual([
      { type: 'text', content: 'Tạo một part' },
      { type: 'call', call: { callId: 'c1', name: 'spawn_part', args: { name: 'Baseplate' }, status: 'running' } },
      { type: 'approval', approval: { approvalId: 'ap_1', callId: 'c1', name: 'spawn_part', args: { name: 'Baseplate' }, risk: 'medium' } },
    ]);

    const done = play(...APPROVAL_TURN);
    expect(done.pendingApproval).toBeNull();
    expect(done.messages[1].steps[2]).toEqual({
      type: 'approval',
      approval: { approvalId: 'ap_1', callId: 'c1', name: 'spawn_part', args: { name: 'Baseplate' }, risk: 'medium', decision: 'allow' },
    });
    expect(done.messages[1].steps[1]).toEqual({
      type: 'call', call: { callId: 'c1', name: 'spawn_part', args: { name: 'Baseplate' }, status: 'done', result: { ok: true }, durationMs: 5 },
    });
    expect(done.messages[2].steps).toEqual([{ type: 'text', content: 'Xong.' }]);
    expect(done.settled).toBe('completed');
  });

  it('sets and clears the pending approval', () => {
    const requested = play(
      { id: 'evt_1', seq: 1, type: 'approval/request', ts: 1, payload: { approvalId: 'ap_1', callId: 'c1', name: 'bash', args: { cmd: 'rm' }, risk: 'high' } },
      { id: 'e2', type: 'agent/status', payload: { state: 'waiting_approval' }, ts: 2 },
    );
    expect(requested.pendingApproval).toEqual({ approvalId: 'ap_1', callId: 'c1', name: 'bash', args: { cmd: 'rm' }, risk: 'high', turnId: null });

    const decided = applyStreamEvent(requested, {
      id: 'evt_2', seq: 2, type: 'approval/decision', ts: 3, payload: { approvalId: 'ap_1', decision: 'allow', scope: 'once' },
    });
    expect(decided.pendingApproval).toBeNull();

    const otherDecision = applyStreamEvent(requested, {
      id: 'evt_3', seq: 3, type: 'approval/decision', ts: 4, payload: { approvalId: 'ap_other', decision: 'deny', scope: 'once' },
    });
    expect(otherDecision.pendingApproval?.approvalId).toBe('ap_1');
  });

  it('updates the title from session/title', () => {
    const state = applyStreamEvent({ ...initialChatState, title: 'New Conversation' }, {
      id: 'evt_1', seq: 1, type: 'session/title', ts: 1, payload: { title: 'Đọc file giúp mình', source: 'auto' },
    });
    expect(state.title).toBe('Đọc file giúp mình');
  });

  it('ends the turn: draft cleared, idle, durable messages untouched', () => {
    const before = play(
      { id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u1', content: 'hi', source: 'user' } },
      { id: 'evt_2', seq: 2, type: 'assistant/message', ts: 2, payload: { messageId: 'a1', content: 'xin chào', finishReason: 'stop', callIds: [] } },
      { id: 'e3', type: 'assistant/delta', payload: { turnId: 't1', text: 'leaked partial' }, ts: 3 },
    );
    const state = applyStreamEvent(before, {
      id: 'evt_3', seq: 3, type: 'turn/end', ts: 4, payload: { turnId: 't1', reason: 'completed' },
    });
    expect(state.draft).toEqual(initialChatState.draft);
    expect(state.status).toBe('idle');
    expect(state.settled).toBe('completed');
    expect(state.messages).toEqual(before.messages);
    expect(state.messages).toHaveLength(2);
  });

  it('treats a cancelled turn as not an error, and still tells it apart from a completed one', () => {
    const cancelled = play(
      { id: 'e1', type: 'assistant/delta', payload: { turnId: 't1', text: 'nửa câu' }, ts: 1 },
      { id: 'e2', type: 'agent/status', payload: { state: 'cancelled', turnId: 't1' }, ts: 2 },
      { id: 'evt_1', seq: 1, type: 'turn/end', ts: 3, payload: { turnId: 't1', reason: 'cancelled' } },
    );
    expect(cancelled.error).toBeNull();
    expect(cancelled.draft.content).toBe('');
    // Ruling 1: the UI renders "stopped", not "failed" — it can only do that from `settled`, since
    // `status` is pushed back to `idle` by loop.ts:249 whatever the reason was.
    expect(cancelled.settled).toBe('cancelled');
    expect(cancelled.status).toBe('idle');

    const completed = applyStreamEvent(cancelled, {
      id: 'evt_2', seq: 2, type: 'turn/end', ts: 4, payload: { turnId: 't2', reason: 'completed' },
    });
    expect(completed.settled).toBe('completed');
    expect(completed.settled).not.toBe(cancelled.settled);
  });

  it('keeps the timeout error alongside turn/end reason error', () => {
    const state = play(
      { id: 'e1', type: 'error', payload: { code: 'TURN_TIMEOUT', message: 'hết thời gian', retryable: false }, ts: 1 },
      { id: 'e2', type: 'agent/status', payload: { state: 'idle' }, ts: 2 },
      { id: 'evt_1', seq: 1, type: 'turn/end', ts: 3, payload: { turnId: 't1', reason: 'error' } },
    );
    expect(state.error?.code).toBe('TURN_TIMEOUT');
    expect(state.status).toBe('idle');
    expect(state.settled).toBe('error');
    expect(state.draft.content).toBe('');
  });

  it('records queued steering as a transport outcome, never as a message', () => {
    const queued = applyStreamEvent(initialChatState, { type: 'transport/queued', payload: { position: 2, message: 'chờ cái này' } });
    expect(queued.queued).toEqual({ messages: ['chờ cái này'], position: 2 });
    expect(queued.messages).toEqual([]);
    expect(queued.error).toBeNull();

    // A second steer appends: the card lists both waits in send order.
    const two = applyStreamEvent(queued, { type: 'transport/queued', payload: { position: 3, message: 'và cái này nữa' } });
    expect(two.queued).toEqual({ messages: ['chờ cái này', 'và cái này nữa'], position: 3 });

    // A queue-clear drops the wait without touching durable rows.
    const cleared = applyStreamEvent(two, { type: 'transport/queued-clear', payload: { cleared: 2 } });
    expect(cleared.queued).toBeNull();
    expect(cleared.messages).toEqual([]);

    const drained = applyStreamEvent(queued, {
      id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u1', content: 'steer', source: 'steer' },
    });
    expect(drained.queued).toBeNull();
    expect(drained.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('clears a stale error when a new turn starts', () => {
    const state = play(
      { id: 'e1', type: 'error', payload: { code: 'SESSION_BUSY', message: 'phiên đang bận', retryable: true }, ts: 1 },
      { id: 'evt_1', seq: 1, type: 'turn/end', ts: 2, payload: { turnId: 't1', reason: 'error' } },
      { id: 'evt_2', seq: 2, type: 'turn/start', ts: 3, payload: { turnId: 't2', modelSelection: 'gemini', trigger: 'user' } },
    );
    expect(state.error).toBeNull();
    expect(state.status).toBe('thinking');
    expect(state.settled).toBeNull();
  });

  it('drops the superseded answer when a regenerate starts, like the reload does', () => {
    // projections.ts:73-77 flags superseded rows and then FILTERS them out of `GET /api/sessions/:id`,
    // so keeping them flagged live would leave the old answer on screen until a refresh.
    const before = play(
      { id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u1', content: 'làm lại giúp mình', source: 'user' } },
      { id: 'evt_2', seq: 2, type: 'assistant/message', ts: 2, payload: { messageId: 'a1', content: 'câu trả lời cũ', finishReason: 'stop', callIds: [] } },
    );
    const state = play2(before, {
      id: 'evt_3', seq: 3, type: 'turn/start', ts: 3,
      payload: {
        turnId: 't2', modelSelection: 'gemini', trigger: 'regenerate',
        regeneratedFrom: { userMessageId: 'u1', supersedesAssistantMessageId: 'a1' },
      },
    });
    expect(state.messages.map((m) => m.id)).toEqual(['u1']);
    expect(state.rowSeqById.a1).toBeUndefined();
  });

  it('drops the whole previous turn tail — thinking/tool rows included — on regenerate', () => {
    // A tool-using turn owns several assistant rows (tool_calls carriers + the final answer).
    // Regenerating must drop that whole tail, not just the superseded final row, or the old
    // "Đã suy nghĩ" block and its tool cards stay on screen above the new answer.
    const before = play(
      { id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u0', content: 'câu trước', source: 'user' } },
      { id: 'evt_2', seq: 2, type: 'assistant/message', ts: 2, payload: { messageId: 'a0', content: 'trả lời trước', finishReason: 'stop', callIds: [] } },
      { id: 'evt_3', seq: 3, type: 'user/message', ts: 3, payload: { messageId: 'u1', content: 'làm lại giúp mình', source: 'user' } },
      { id: 'evt_4', seq: 4, type: 'assistant/message', ts: 4, payload: { messageId: 'a1', content: '', reasoning: 'suy nghĩ cũ', finishReason: 'tool_calls', callIds: ['c1'] } },
      { id: 'evt_5', seq: 5, type: 'tool/call', ts: 5, payload: { callId: 'c1', name: 'run_command', args: { cmd: 'ls' }, startedAt: 5 } },
      { id: 'evt_6', seq: 6, type: 'assistant/message', ts: 6, payload: { messageId: 'a2', content: 'câu trả lời cũ', finishReason: 'stop', callIds: [] } },
    );
    expect(before.messages.map((m) => m.id)).toEqual(['u0', 'a0', 'u1', 'a1', 'a2']);

    const state = play2(before, {
      id: 'evt_7', seq: 7, type: 'turn/start', ts: 7,
      payload: {
        turnId: 't2', modelSelection: 'gemini', trigger: 'regenerate',
        regeneratedFrom: { userMessageId: 'u1', supersedesAssistantMessageId: 'a2' },
      },
    });
    expect(state.messages.map((m) => m.id)).toEqual(['u0', 'a0', 'u1']);
  });

  it('replays a compaction summary the way the projection does: covered rows out, summary row in', () => {
    // projections.ts:55-69 splices every row whose seq is inside [coveredFrom, coveredTo] and inserts
    // one `summary_<seq>` system row ahead of the first row that survives past the range.
    const state = play(
      { id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u1', content: 'câu 1', source: 'user' } },
      { id: 'evt_2', seq: 2, type: 'assistant/message', ts: 2, payload: { messageId: 'a1', content: 'trả lời 1', finishReason: 'stop', callIds: [] } },
      { id: 'evt_3', seq: 3, type: 'user/message', ts: 3, payload: { messageId: 'u2', content: 'câu 2', source: 'user' } },
      { id: 'evt_4', seq: 4, type: 'assistant/message', ts: 4, payload: { messageId: 'a2', content: 'trả lời 2', finishReason: 'stop', callIds: [] } },
      { id: 'evt_5', seq: 5, type: 'compaction/summary', ts: 5, payload: { summary: 'Tóm tắt phần đầu', coveredFrom: 1, coveredTo: 3, tokenEstimate: 4 } },
    );
    expect(state.messages.map((m) => m.id)).toEqual(['summary_5', 'a2']);
    expect(state.messages[0]).toMatchObject({ role: 'system', content: 'Tóm tắt phần đầu', steps: [], superseded: false });
  });

  it('does not mutate the state it was given', () => {
    const frame: StreamEnvelope = {
      id: 'evt_1', seq: 1, type: 'user/message', ts: 1, payload: { messageId: 'u1', content: 'hi', source: 'user' },
    };
    const frozen = { ...initialChatState, draft: { ...initialChatState.draft, steps: [] } };
    const next = applyStreamEvent(frozen, frame);
    expect(frozen.messages).toEqual([]);
    expect(next.messages).toHaveLength(1);
    expect(next).not.toBe(frozen);
  });
});
