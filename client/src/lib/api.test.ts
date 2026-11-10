import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import { applyStreamEvent, initialChatState } from './chatReducer';
import type { QueuedFrame, ChatAction } from './chatReducer';
import type { StreamEnvelope } from '../types';

vi.mock('./token', () => ({ getToken: async () => 'test-token' }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

const encoder = new TextEncoder();

/** The last argument is the `ResponseInit` the mock answers with. */
function reply(body: BodyInit | null, init: ResponseInit = {}) {
  fetchMock.mockResolvedValue(new Response(body, init));
}

function json(body: unknown, status = 200) {
  reply(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sse(parts: string[], status = 200) {
  reply(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Envelope `data:` lines, in server order, terminated like the harness writes them. */
function frameLines(frames: unknown[]): string[] {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
}

const envelope = <T extends string>(type: T, payload: unknown, extra: Record<string, unknown> = {}) => ({
  id: `evt_${type}`,
  type,
  payload,
  ts: 1,
  ...extra,
});

const durable = (type: string, payload: unknown, seq: number) => envelope(type, payload, { seq, id: `evt_${seq}` });

/** A stream that yields `first` and then fails the next read with `error` (abort / transport blow-up). */
function streamFailsAfter(first: string, error: unknown) {
  let pulls = 0;
  reply(new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(first));
        return;
      }
      controller.error(error);
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function calls(): [string, RequestInit][] {
  return fetchMock.mock.calls as [string, RequestInit][];
}

function callAt(index: number): [string, RequestInit] {
  const call = calls()[index];
  expect(call, `fetch call #${index}`).toBeDefined();
  return call;
}

function headersOf(init: RequestInit): Headers {
  return init.headers as Headers;
}

function bodyOf(init: RequestInit): unknown {
  return init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(() => {
    throw new Error('expected the call to reject');
  }, (error: unknown) => error as ApiError);
}

const streamParams = { sessionId: 's1', message: 'hi', model: 'm1', effort: 'high' as const };

function collect() {
  const frames: ChatAction[] = [];
  const onEvent = vi.fn((frame: ChatAction) => { frames.push(frame); });
  return { frames, onEvent };
}

describe('api request wrapper', () => {
  it('sends the token header on every request and never in a URL', async () => {
    json([]);
    await api.sessions.list();
    json([]);
    await api.models.list();
    expect(calls()).toHaveLength(2);
    for (const [url, init] of calls()) {
      expect(headersOf(init).get('X-Morphi-Token')).toBe('test-token');
      expect(url).toMatch(/^\/api\//);
      expect(url).not.toContain('token');
    }
  });

  it('reads the error envelope as a code, not a string', async () => {
    json({ error: { code: 'SESSION_NOT_FOUND', message: 'không tìm thấy phiên' } }, 404);
    const error = await failure(api.sessions.get('s1'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('SESSION_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.message).toBe('không tìm thấy phiên');
  });

  it('keeps `details` and falls back to the status when the body is not the envelope', async () => {
    json({ error: { code: 'VALIDATION_ERROR', details: [{ path: 'body.message', code: 'too_small' }] } }, 400);
    const validation = await failure(api.chat.cancel('s1'));
    expect(validation.details).toEqual([{ path: 'body.message', code: 'too_small' }]);

    reply('<html>gateway down</html>', { status: 502, statusText: 'Bad Gateway' });
    const raw = await failure(api.projects.list());
    expect(raw.code).toBe('HTTP_502');
    expect(raw.status).toBe(502);
  });

  it('rejects a non-ok stream without touching onEvent', async () => {
    json({ error: { code: 'SESSION_BUSY', message: 'phiên đang bận' } }, 409);
    const { onEvent, frames } = collect();
    const error = await failure(api.chat.regenerate(
      { sessionId: 's1', assistantMessageId: 'a1' },
      onEvent,
    ));
    expect(error.code).toBe('SESSION_BUSY');
    expect(onEvent).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
  });
});

describe('api REST surface', () => {
  it('projects', async () => {
    json([{ id: 'p1', name: 'Demo', createdAt: 1, lastActive: 1 }]);
    await api.projects.list();
    expect(callAt(0)[0]).toBe('/api/projects');
    expect(callAt(0)[1].method ?? 'GET').toBe('GET');

    json({ id: 'p1', name: 'Demo', createdAt: 1, lastActive: 1 }, 201);
    await api.projects.create({ name: 'Demo' });
    expect(callAt(1)).toEqual(['/api/projects', expect.objectContaining({ method: 'POST' })]);
    expect(bodyOf(callAt(1)[1])).toEqual({ name: 'Demo' });

    json({ ok: true, id: 'p1' });
    await api.projects.delete('p1');
    expect(callAt(2)[0]).toBe('/api/projects/p1');
    expect(callAt(2)[1].method).toBe('DELETE');
  });

  it('sessions: list adds projectId only when given', async () => {
    json([]);
    await api.sessions.list();
    expect(callAt(0)[0]).toBe('/api/sessions');

    json([]);
    await api.sessions.list('p 1');
    expect(callAt(1)[0]).toBe('/api/sessions?projectId=p%201');
  });

  it('sessions: create/get/pin/delete hit the documented routes', async () => {
    json({ id: 's1' }, 201);
    await api.sessions.create({ projectId: 'p1', title: 'T', model: 'm1' });
    expect(bodyOf(callAt(0)[1])).toEqual({ projectId: 'p1', title: 'T', model: 'm1' });

    json({ id: 's1', messages: [] });
    await api.sessions.get('s1');
    expect(callAt(1)[0]).toBe('/api/sessions/s1');
    expect(callAt(1)[1].method).toBeUndefined();

    json({ id: 's1', isPinned: true });
    await api.sessions.pin('s1');
    expect(callAt(2)[0]).toBe('/api/sessions/s1/pin');
    expect(callAt(2)[1].method).toBe('POST');
    expect(bodyOf(callAt(2)[1])).toBeUndefined();

    json({ id: 's1', isPinned: false });
    await api.sessions.pin('s1', false);
    expect(bodyOf(callAt(3)[1])).toEqual({ pinned: false });

    json({ ok: true, id: 's1' });
    await api.sessions.delete('s 1');
    expect(callAt(4)[0]).toBe('/api/sessions/s%201');
    expect(callAt(4)[1].method).toBe('DELETE');
  });

  it('models lists usable models only — no refresh flag, no /models/providers', async () => {
    json([]);
    await api.models.list();
    expect(callAt(0)[0]).toBe('/api/models');
    const urls = calls().map(([url]) => url);
    expect(urls.some((url) => url.includes('refresh'))).toBe(false);
    expect(urls.some((url) => url.includes('/models/providers'))).toBe(false);
  });

  it('providers: list and per-provider config', async () => {
    json([]);
    await api.providers.list();
    expect(callAt(0)[0]).toBe('/api/providers');

    json({ providerId: 'custom:x', configured: true, enabled: true, baseUrl: 'http://a', custom: true });
    await api.providers.updateConfig('custom:x', { baseUrl: 'http://a' });
    expect(callAt(1)).toEqual(['/api/providers/custom%3Ax/config', expect.objectContaining({ method: 'PUT' })]);
    expect(bodyOf(callAt(1)[1])).toEqual({ baseUrl: 'http://a' });
  });

  it('tools: session-scoped listing and toggle', async () => {
    json([]);
    await api.tools.list();
    expect(callAt(0)[0]).toBe('/api/tools');

    json([]);
    await api.tools.list('s1');
    expect(callAt(1)[0]).toBe('/api/tools?sessionId=s1');

    json({ sessionId: 's1', name: 'write', enabled: false });
    await api.tools.toggle('s1', 'write', false);
    expect(callAt(2)[0]).toBe('/api/sessions/s1/tools/write');
    expect(callAt(2)[1].method).toBe('POST');
    expect(bodyOf(callAt(2)[1])).toEqual({ enabled: false });
  });

  it('mcp and memory', async () => {
    json({ connected: false, studioLinked: false, server: { source: 'none', path: null, version: null }, logs: [] });
    await api.mcp.status();
    expect(callAt(0)[0]).toBe('/api/mcp/status');

    json({ connected: true, studioLinked: false, server: { source: 'none', path: null, version: null }, logs: [] });
    await api.mcp.reconnect();
    expect(callAt(1)[0]).toBe('/api/mcp/reconnect');
    expect(callAt(1)[1].method).toBe('POST');

    json({ projects: 1, sessions: 2, events: 3, approxBytes: 4 });
    await api.memory.stats();
    expect(callAt(2)[0]).toBe('/api/memory/stats');

    json({ ok: true, cleared: { projects: 1, sessions: 2, events: 3 } });
    await api.memory.clear();
    expect(callAt(3)[0]).toBe('/api/memory');
    expect(callAt(3)[1].method).toBe('DELETE');
  });

  it('approvals.decide posts the strict decision body', async () => {
    json({ ok: true, approvalId: 'ap1', decision: 'allow', scope: 'session' });
    await api.approvals.decide('ap1', { decision: 'allow', scope: 'session' });
    expect(callAt(0)[0]).toBe('/api/approvals/ap1');
    expect(callAt(0)[1].method).toBe('POST');
    expect(bodyOf(callAt(0)[1])).toEqual({ decision: 'allow', scope: 'session' });
  });

  it('chat.cancel posts the session id and reports whether a turn stopped', async () => {
    json({ sessionId: 's1', cancelled: false });
    await expect(api.chat.cancel('s1')).resolves.toEqual({ sessionId: 's1', cancelled: false });
    expect(callAt(0)[0]).toBe('/api/chat/cancel');
    expect(bodyOf(callAt(0)[1])).toEqual({ sessionId: 's1' });
  });
});

describe('api.chat.stream transport', () => {
  it('dispatches every envelope in server order and resolves', async () => {
    sse(frameLines([
      durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
      durable('user/message', { messageId: 'u1', content: 'hi', source: 'user' }, 2),
      envelope('assistant/delta', { turnId: 't1', text: 'Hel' }),
      envelope('assistant/delta', { turnId: 't1', text: 'lo' }),
      durable('assistant/message', { messageId: 'a1', content: 'Hello', finishReason: 'stop', callIds: [] }, 3),
      envelope('agent/status', { state: 'idle', turnId: 't1' }),
      durable('turn/end', { turnId: 't1', reason: 'completed' }, 4),
    ]));
    const { frames, onEvent } = collect();
    await expect(api.chat.stream(streamParams, onEvent)).resolves.toBeUndefined();

    expect(frames.map((f) => f.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/delta',
      'assistant/delta',
      'assistant/message',
      'agent/status',
      'turn/end',
    ]);
    expect((frames[2] as StreamEnvelope).seq).toBeUndefined();
    expect(frames[6]).toMatchObject({ seq: 4, payload: { reason: 'completed' } });

    const [url, init] = callAt(0);
    expect(url).toBe('/api/chat/stream');
    expect(init.method).toBe('POST');
    expect(headersOf(init).get('X-Morphi-Token')).toBe('test-token');
    expect(bodyOf(init)).toEqual({ sessionId: 's1', message: 'hi', model: 'm1', effort: 'high' });
  });

  it('batch-flushes live deltas in order, before any durable frame that follows', async () => {
    // Deepseek-style display throttle: a burst of deltas in one read must still
    // reach the UI in server order and ahead of the durable frame after it —
    // never reordered, never dropped, never dumped after `turn/end`.
    const deltas = Array.from({ length: 30 }, (_, i) => envelope('assistant/delta', { turnId: 't1', text: `w${i} ` }));
    sse(frameLines([
      durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
      ...deltas,
      envelope('thought/delta', { turnId: 't1', text: 'thinking' }),
      durable('assistant/message', { messageId: 'a1', content: 'done', finishReason: 'stop', callIds: [] }, 2),
      durable('turn/end', { turnId: 't1', reason: 'completed' }, 3),
    ]));
    const { frames, onEvent } = collect();
    await api.chat.stream(streamParams, onEvent);

    const deltaTexts = frames.filter((f) => f.type === 'assistant/delta').map((f) => (f.payload as { text: string }).text);
    expect(deltaTexts).toEqual(Array.from({ length: 30 }, (_, i) => `w${i} `));
    const types = frames.map((f) => f.type);
    expect(types.indexOf('assistant/message')).toBeGreaterThan(types.lastIndexOf('assistant/delta'));
    expect(types.indexOf('thought/delta')).toBeLessThan(types.indexOf('assistant/message'));
    expect(types.at(-1)).toBe('turn/end');
  });

  it('forwards a session/title that lands after turn/end instead of dropping it', async () => {
    // `routes/chat.ts` writes the auto-title whenever the response is still open, so it can arrive
    // after the terminal frame; the reducer still has to see it.
    sse(frameLines([
      durable('turn/end', { turnId: 't1', reason: 'completed' }, 5),
      durable('session/title', { title: 'Bổ trợ Roblox', source: 'auto' }, 6),
    ]));
    const { frames, onEvent } = collect();
    await api.chat.stream(streamParams, onEvent);
    expect(frames.map((f) => f.type)).toEqual(['turn/end', 'session/title']);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('dispatches transport/queued for a 202 and never reads a stream', async () => {
    json({ queued: true }, 202);
    const { frames, onEvent } = collect();
    await api.chat.stream({ sessionId: 's1', message: 'steer me' }, onEvent);
    // No message echoed by the server: the sent text is the fallback so the card can show it.
    expect(frames).toEqual<QueuedFrame[]>([{ type: 'transport/queued', payload: { message: 'steer me' } }]);
    expect((frames[0] as QueuedFrame).payload.position).toBeUndefined();

    json({ queued: true, position: 2, message: 'again' }, 202);
    const second = collect();
    await api.chat.stream({ sessionId: 's1', message: 'again' }, second.onEvent);
    expect(second.frames).toEqual<QueuedFrame[]>([{ type: 'transport/queued', payload: { position: 2, message: 'again' } }]);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('passes a live error frame through instead of failing the transport', async () => {
    sse(frameLines([
      envelope('error', { code: 'TURN_TIMEOUT', message: 'hết thời gian', retryable: false }),
      envelope('agent/status', { state: 'idle', turnId: 't1' }),
      durable('turn/end', { turnId: 't1', reason: 'error' }, 9),
    ]));
    const { frames, onEvent } = collect();
    await expect(api.chat.stream(streamParams, onEvent)).resolves.toBeUndefined();
    expect(frames.map((f) => f.type)).toEqual(['error', 'agent/status', 'turn/end']);
    expect(frames[0]).toMatchObject({ payload: { code: 'TURN_TIMEOUT' } });
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it('ignores malformed data, comments and the legacy [DONE] sentinel', async () => {
    sse([
      ': ping\n\n',
      'data: not-json\n\n',
      'data: null\n\n',
      'data: [DONE]\n\n',
      ...frameLines([durable('turn/end', { turnId: 't1', reason: 'completed' }, 1)]),
    ]);
    const { frames, onEvent } = collect();
    await api.chat.stream(streamParams, onEvent);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('turn/end');
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('flushes a trailing frame that the server never newline-terminated', async () => {
    sse(['data: ' + JSON.stringify(durable('turn/end', { turnId: 't1', reason: 'completed' }, 1))]);
    const { frames } = collect();
    const onEvent = (frame: ChatAction) => { frames.push(frame); };
    await api.chat.stream(streamParams, onEvent);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('turn/end');
  });

  it('routes a turn/end reason when the transport closes early', async () => {
    sse(frameLines([
      durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
      envelope('assistant/delta', { turnId: 't1', text: 'partial' }),
    ]));
    const { frames, onEvent } = collect();
    await expect(api.chat.stream(streamParams, onEvent)).resolves.toBeUndefined();
    const closing = frames.filter((f) => f.type === 'turn/end');
    expect(closing).toHaveLength(1);
    expect(closing[0]).toMatchObject({ type: 'turn/end', payload: { turnId: 't1', reason: 'error' } });
    // The synthetic close repeats the last durable seq it saw; it is not a row of its own.
    expect((closing[0] as StreamEnvelope).seq).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it('resolves with zero frames when aborted before the first byte', async () => {
    // Cái pin Task 19B's review đòi: chưa có byte nào nghĩa là chưa có turn nào, nên không có
    // `turn/end` tổng hợp và cũng không có frame nào cả. Logic abort/reset của 19C (ChatInterface)
    // chỉ đúng nếu bất biến này đứng — nó không được "dọn" state từ 0 frame.
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { frames, onEvent } = collect();
    await expect(api.chat.stream(streamParams, onEvent)).resolves.toBeUndefined();
    expect(frames).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('treats an aborted stream as a cancellation, not an error', async () => {
    streamFailsAfter(
      frameLines([durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1)])[0],
      new DOMException('aborted', 'AbortError'),
    );
    const { frames, onEvent } = collect();
    await expect(api.chat.stream(streamParams, onEvent)).resolves.toBeUndefined();
    expect(frames.map((f) => f.type)).toEqual(['turn/start', 'turn/end']);
    expect(frames[1]).toMatchObject({ payload: { turnId: 't1', reason: 'cancelled' } });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('settles the turn then rejects when the reader fails for another reason', async () => {
    streamFailsAfter('', new TypeError('socket hang up'));
    const { frames, onEvent } = collect();
    const error = await failure(api.chat.stream(streamParams, onEvent));
    expect(error.code).toBe('TRANSPORT_ERROR');
    expect(frames.map((f) => f.type)).toEqual(['turn/end']);
    expect(frames[0]).toMatchObject({ payload: { reason: 'error' } });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('never dispatches after a 202 and never opens a stream for JSON', async () => {
    reply('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { onEvent } = collect();
    const error = await failure(api.chat.stream(streamParams, onEvent));
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.status).toBe(200);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('regenerate streams exactly like stream and hits /chat/regenerate', async () => {
    sse(frameLines([
      durable('turn/start', { turnId: 't2', modelSelection: 'auto', trigger: 'regenerate' }, 1),
      durable('turn/end', { turnId: 't2', reason: 'completed' }, 2),
    ]));
    const { frames, onEvent } = collect();
    await api.chat.regenerate({ sessionId: 's1', assistantMessageId: 'a1' }, onEvent);
    expect(callAt(0)[0]).toBe('/api/chat/regenerate');
    expect(bodyOf(callAt(0)[1])).toEqual({ sessionId: 's1', assistantMessageId: 'a1' });
    expect(frames.map((f) => f.type)).toEqual(['turn/start', 'turn/end']);
  });

  it('feeds the Task 19A reducer into the state a reload would show', async () => {
    sse(frameLines([
      durable('turn/start', { turnId: 't1', modelSelection: 'auto', trigger: 'user' }, 1),
      durable('user/message', { messageId: 'u1', content: 'hi', source: 'user' }, 2),
      envelope('assistant/delta', { turnId: 't1', text: 'Hello' }),
      durable('assistant/message', { messageId: 'a1', content: 'Hello', finishReason: 'stop', callIds: [] }, 3),
      durable('turn/end', { turnId: 't1', reason: 'completed' }, 4),
    ]));
    let state = initialChatState;
    await api.chat.stream(streamParams, (frame) => { state = applyStreamEvent(state, frame); });
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(state.draft.content).toBe('');
    expect(state.settled).toBe('completed');
    expect(state.status).toBe('idle');
    expect(state.rowSeqById).toEqual({ u1: 2, a1: 3 });
    expect(state.toolProgress).toEqual({});
  });

  it('keeps the persisted seq on durable envelopes and none on live ones', async () => {
    const frames: ChatAction[] = [];
    sse(frameLines([
      durable('user/message', { messageId: 'u1', content: 'hi', source: 'user' }, 7),
      envelope('assistant/delta', { turnId: 't1', text: 'x' }),
      durable('turn/end', { turnId: 't1', reason: 'completed' }, 8),
    ]));
    await api.chat.stream(streamParams, (frame) => { frames.push(frame); });
    expect(frames.map((frame) => (frame as { seq?: number }).seq)).toEqual([7, undefined, 8]);
    expect(frames[0]).toMatchObject({ id: 'evt_7' });
  });
});
