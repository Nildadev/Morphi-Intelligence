import type Database from 'better-sqlite3';
import type { Express, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test/db';
import { createApp } from '../app';
import type { EventPayloadMap, EventType, SessionEvent } from '../harness/events/types';
import { createHarness, type Harness } from '../harness/harness';
import { LlmRegistry } from '../harness/llm/registry';
import { createProviderSettingsStore } from '../harness/llm/settings';
import type { ModelInfo, ProviderAdapter, LlmRequest, StreamEvent } from '../harness/llm/types';
import type { JsonSchema } from '../harness/shared/types';
import type { McpGateway, McpSource, ToolDefinition } from '../harness/tools/types';
import { SSE_PING_INTERVAL_MS } from '../http/sse';
import { mountRoutes } from './index';
import { DEFAULT_TITLE } from './sessions';

const TOKEN = 'test-token';
const TEST_MODEL: ModelInfo = {
  id: 'fake-model',
  name: 'Fake Model',
  provider: 'fake',
  providerLabel: 'Fake',
  context: 128_000,
  supportsTools: true,
};

/** Route tests only need the Task 14 surface; the turn never calls a tool on this gateway. */
class StubGateway {
  connected = false;
  studioLinked = false;
  server = { source: 'none' as McpSource, path: null, version: null };
  async listTools(): Promise<never[]> {
    return [];
  }
  async callTool(): Promise<null> {
    return null;
  }
  async reconnect(): Promise<void> {}
}

type TestStep = StreamEvent | { readonly wait: 'abort' };

const text = (value: string): StreamEvent => ({ type: 'text_delta', text: value });
const stop = (): StreamEvent => ({ type: 'finish', reason: 'stop' });
const waitAbort = (): TestStep => ({ wait: 'abort' });
const providerError = (message: string, status?: number): StreamEvent => ({
  type: 'error',
  error: { code: 'http_error', message, retryable: status === undefined ? true : status === 429 || status >= 500, ...(status === undefined ? {} : { status }) },
});

function callsStep(callId: string, name: string): TestStep[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_call_end', callId, name, args: {} },
    { type: 'finish', reason: 'tool_calls' },
  ];
}

/** A provider that streamed argument deltas and never closed the call with parsed ones. */
function corruptCallStep(callId: string, name: string): TestStep[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_call_delta', callId, argsDelta: '{"path": ' },
    { type: 'tool_call_end', callId, name, args: undefined },
    { type: 'finish', reason: 'tool_calls' },
  ];
}

class ScriptedAdapter implements ProviderAdapter {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly requests: LlmRequest[] = [];
  private cursor = 0;

  constructor(private readonly model: ModelInfo, private readonly script: TestStep[][]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [this.model];
  }

  stream(request: LlmRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    // Past the last scripted step the last one repeats, so multi-turn tests keep answering.
    const steps = this.script[Math.min(this.cursor, this.script.length - 1)] ?? [];
    this.cursor += 1;
    const signal = request.signal;
    return (async function* play(): AsyncGenerator<StreamEvent> {
      for (const step of steps) {
        if ('wait' in step) {
          if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          }
          yield { type: 'finish', reason: 'cancelled' };
          return;
        }
        yield step;
      }
    })();
  }
}

interface SseFrame {
  id: string;
  seq?: number;
  type: string;
  payload: any;
  ts: number;
}

function sseFrames(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)) as SseFrame);
}

const dbs: Database.Database[] = [];

async function buildTestHarness(script: TestStep[][], options: { credentials?: boolean } = {}): Promise<{ harness: Harness; adapter: ScriptedAdapter }> {
  const db = createTestDb();
  dbs.push(db);
  const adapter = new ScriptedAdapter(TEST_MODEL, script);
  const llm = new LlmRegistry([adapter], ['fake']);
  const harness = createHarness({
    db,
    llm,
    mcp: new StubGateway() as unknown as McpGateway,
    titleModel: 'auto',
    providerSettings: createProviderSettingsStore(db),
    compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
  });
  if (options.credentials !== false) {
    llm.setCredentials({ fake: 'sk-fake' });
    await llm.refreshModels();
  }
  return { harness, adapter };
}

function buildApp(harness: Harness): Express {
  return createApp({ token: TOKEN, version: '1.1.0', mount: (app) => mountRoutes(app, harness) });
}

function api(app: Express) {
  const withToken = <T extends request.Test>(call: T): T => call.set('X-Morphi-Token', TOKEN);
  return {
    get: (url: string) => withToken(request(app).get(url)),
    post: (url: string) => withToken(request(app).post(url)),
    del: (url: string) => withToken(request(app).delete(url)),
  };
}

function makeSession(harness: Harness, title = 'Spawn test'): string {
  const project = harness.projects.create('Wave Spawner');
  return harness.sessions.create(project.id, title).id;
}

/**
 * Opens a stream without waiting for the turn: supertest fires the request here, and the returned
 * promise resolves with the buffered body once the server ends the SSE response.
 */
function openStream(app: Express, url: string, body: unknown): Promise<{ status: number; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    api(app)
      .post(url)
      .send(body)
      .end((error, response) => {
        if (error) reject(error);
        else resolve({ status: response.status, text: response.text, contentType: String(response.headers['content-type'] ?? '') });
      });
  });
}

async function runStream(app: Express, sessionId: string, message: string, extra: Record<string, unknown> = {}): Promise<SseFrame[]> {
  const res = await openStream(app, '/api/chat/stream', { sessionId, message, ...extra });
  expect(res.status).toBe(200);
  expect(res.contentType).toContain('text/event-stream');
  return sseFrames(res.text);
}

/**
 * Fires a stream request without waiting for the turn, and hands back the in-flight supertest call
 * (so the test can close the client socket with `abort()`) plus a promise that settles with whatever
 * the client managed to read before the exchange ended.
 */
function startStream(app: Express, body: Record<string, unknown>): {
  call: request.Test;
  closed: Promise<{ status: number; text: string }>;
} {
  const call = api(app).post('/api/chat/stream').send(body);
  const closed = new Promise<{ status: number; text: string }>((resolve) => {
    call.end((_error, response) => resolve({ status: response?.status ?? 0, text: response?.text ?? '' }));
  });
  return { call, closed };
}

function rowsOfType(harness: Harness, sessionId: string, type: EventType): SessionEvent[] {
  return harness.events.list(sessionId).filter((event) => event.type === type);
}

/**
 * Every durable `turn/*` row of a session, read from the real event store: a rejected regenerate has
 * to leave this list untouched, not merely answer the right status.
 */
function turnRows(harness: Harness, sessionId: string): SessionEvent[] {
  return harness.events.list(sessionId).filter((event) => event.type.startsWith('turn/'));
}

function framesOfType(frames: SseFrame[], type: string): SseFrame[] {
  return frames.filter((frame) => frame.type === type);
}

function statusFrames(frames: SseFrame[]): string[] {
  return framesOfType(frames, 'agent/status').map((frame) => frame.payload.state as string);
}

function toolDefinition(
  name: string,
  approval: ToolDefinition['approval'],
  risk: 'low' | 'medium' | 'high',
  execute: ToolDefinition['execute'],
  parameters: JsonSchema = { type: 'object', additionalProperties: true },
): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters,
    execute,
    isConcurrencySafe: true,
    approval,
    presentation: { label: name, risk },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length > 0) {
    dbs.pop()!.close();
  }
});

describe('chat stream: plain text turn', () => {
  it('streams deltas and durable events and ends with turn/end completed', async () => {
    const { harness } = await buildTestHarness([[text('Xin '), text('chào'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const frames = await runStream(app, sessionId, 'Xin chào');

    expect(harness.busy(sessionId)).toBe(false);
    const turnStart = frames[0];
    expect(turnStart.type).toBe('turn/start');
    expect(turnStart.seq).toBe(2); // after the persisted `session/created`
    expect(turnStart.id).toBe(`evt_${rowsOfType(harness, sessionId, 'turn/start')[0].id}`);
    const turnId = turnStart.payload.turnId as string;
    expect(turnId).toMatch(/^turn_/);

    const deltas = framesOfType(frames, 'assistant/delta');
    expect(deltas.map((frame) => frame.payload.text)).toEqual(['Xin ', 'chào']);
    for (const delta of deltas) {
      expect(delta.seq).toBeUndefined();
      expect(delta.id).toMatch(/^evt_/);
      expect(delta.payload.turnId).toBe(turnId);
      expect(typeof delta.ts).toBe('number');
    }

    const userRow = rowsOfType(harness, sessionId, 'user/message')[0];
    expect(userRow.payload).toEqual({ messageId: expect.any(String), content: 'Xin chào', source: 'user' });
    const assistantRow = rowsOfType(harness, sessionId, 'assistant/message')[0];
    expect(assistantRow.payload.content).toBe('Xin chào');

    const turnEnd = framesOfType(frames, 'turn/end');
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0].payload).toEqual({ turnId, reason: 'completed' });
    expect(statusFrames(frames)).toEqual(['thinking', 'idle']);

    // The stream carries every durable row exactly as persisted, ids and seqs included; the live
    // frames interleave without a seq.
    const persisted = harness.events.list(sessionId).slice(1);
    const durableFrames = frames.filter((frame) => frame.seq !== undefined);
    expect(durableFrames.map((frame) => [frame.seq, frame.type])).toEqual(persisted.map((row) => [row.seq, row.type]));
    expect(durableFrames.every((frame) => frame.id === `evt_${persisted.find((row) => row.seq === frame.seq)?.id}`)).toBe(true);
  });

  it('refuses to stream into an unknown session and an invalid body, before any SSE header', async () => {
    const { harness } = await buildTestHarness([[stop()]]);
    const app = buildApp(harness);

    const invalid = await api(app).post('/api/chat/stream').send({ sessionId: 'sess_1' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.headers['content-type']).toContain('application/json');

    const missing = await api(app).post('/api/chat/stream').send({ sessionId: 'sess_missing', message: 'alo' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('answers JSON before the stream when no provider is usable', async () => {
    const { harness } = await buildTestHarness([[stop()]], { credentials: false });
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const res = await api(app).post('/api/chat/stream').send({ sessionId, message: 'alo' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PROVIDER');
    expect(res.headers['content-type']).toContain('application/json');
    expect(harness.busy(sessionId)).toBe(false);
  });

  it('persists a requested model on the session row', async () => {
    const { harness } = await buildTestHarness([[text('ok'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    await runStream(app, sessionId, 'Bằng fake-model', { model: 'fake-model' });
    expect(harness.sessions.get(sessionId)?.modelSelection).toBe('fake-model');
  });

  it('accepts the full declared effort range and the reply language on the stream body', async () => {
    const { harness, adapter } = await buildTestHarness([[text('ok'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const frames = await runStream(app, sessionId, 'Xin chào', { effort: 'xhigh', language: 'vi' });
    expect(framesOfType(frames, 'turn/end')[0].payload.reason).toBe('completed');
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].effort).toBe('xhigh');
    expect(adapter.requests[0].messages[0].content).toContain('Reply language: Vietnamese');
  });

  it('ends the stream with an error frame when the provider fails mid-stream', async () => {
    const { harness } = await buildTestHarness([[text('một nửa'), providerError('bad request', 400), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const frames = await runStream(app, sessionId, 'Lỗi giữa dòng');

    const errors = framesOfType(frames, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ code: 'http_error', retryable: false });
    expect(errors[0].seq).toBeUndefined();
    const turnEnd = framesOfType(frames, 'turn/end');
    expect(turnEnd[0].payload.reason).toBe('error');
    expect(rowsOfType(harness, sessionId, 'turn/end')[0].payload.reason).toBe('error');
    expect(statusFrames(frames)).toEqual(['thinking', 'idle']);
  });
});

describe('chat stream: approvals', () => {
  it('waits for an approval decision and resumes the tool after POST /api/approvals/:id', async () => {
    const executed: unknown[] = [];
    const { harness } = await buildTestHarness([callsStep('call_1', 'spawn_part'), [text('Xong.'), stop()]]);
    const app = buildApp(harness);
    harness.tools.register(toolDefinition('spawn_part', 'ask', 'medium', async (args) => {
      executed.push(args);
      return { ok: true };
    }));
    const sessionId = makeSession(harness);

    const stream = openStream(app, '/api/chat/stream', { sessionId, message: 'Tạo một part' });
    await expect.poll(() => rowsOfType(harness, sessionId, 'approval/request').length, { timeout: 3000 }).toBe(1);
    const requestRow = rowsOfType(harness, sessionId, 'approval/request')[0];
    expect(requestRow.payload).toMatchObject({ callId: 'call_1', name: 'spawn_part', risk: 'medium' });
    expect(harness.busy(sessionId)).toBe(true);

    const decided = await api(app).post(`/api/approvals/${requestRow.payload.approvalId}`).send({ decision: 'allow', scope: 'once' });
    expect(decided.status).toBe(200);
    expect(decided.body).toEqual({ ok: true, approvalId: requestRow.payload.approvalId, decision: 'allow', scope: 'once' });

    const frames = sseFrames((await stream).text);
    expect(framesOfType(frames, 'approval/request')[0].payload.approvalId).toBe(requestRow.payload.approvalId);
    expect(framesOfType(frames, 'approval/decision')[0].payload).toMatchObject({ decision: 'allow', scope: 'once' });
    expect(executed).toEqual([{}]);
    const toolResult = rowsOfType(harness, sessionId, 'tool/result')[0].payload as EventPayloadMap['tool/result'];
    expect(toolResult).toMatchObject({ callId: 'call_1', status: 'done' });
    expect(framesOfType(frames, 'tool/progress')[0].payload).toMatchObject({ callId: 'call_1' });
    // The brief's scenario 2 names it: after the approval the tool result AND the next assistant
    // message must both reach the client and land durably.
    expect(framesOfType(frames, 'assistant/delta').map((frame) => frame.payload.text)).toContain('Xong.');
    const assistantRows = rowsOfType(harness, sessionId, 'assistant/message');
    expect((assistantRows[assistantRows.length - 1].payload as EventPayloadMap['assistant/message']).content).toBe('Xong.');
    expect(framesOfType(frames, 'turn/end')[0].payload.reason).toBe('completed');
    expect(statusFrames(frames)).toEqual(['thinking', 'tool', 'waiting_approval', 'tool', 'thinking', 'idle']);
  });

  it('404s an unknown approval id and rejects a malformed decision', async () => {
    const { harness } = await buildTestHarness([[stop()]]);
    const app = buildApp(harness);

    const missing = await api(app).post('/api/approvals/ap_missing').send({ decision: 'allow', scope: 'once' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('APPROVAL_NOT_FOUND');

    const malformed = await api(app).post('/api/approvals/ap_1').send({ decision: 'maybe', scope: 'once' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a deny settles the call as APPROVAL_DENIED and the assistant answers without the tool', async () => {
    const executed: unknown[] = [];
    const { harness } = await buildTestHarness([callsStep('call_1', 'dangerous_op'), [text('Không làm.'), stop()]]);
    const app = buildApp(harness);
    harness.tools.register(toolDefinition('dangerous_op', 'ask', 'high', async (args) => {
      executed.push(args);
      return { ok: true };
    }));
    const sessionId = makeSession(harness);

    const stream = openStream(app, '/api/chat/stream', { sessionId, message: 'Xóa tất cả' });
    await expect.poll(() => rowsOfType(harness, sessionId, 'approval/request').length, { timeout: 3000 }).toBe(1);
    const approvalId = rowsOfType(harness, sessionId, 'approval/request')[0].payload.approvalId;
    expect((await api(app).post(`/api/approvals/${approvalId}`).send({ decision: 'deny', scope: 'once' })).status).toBe(200);

    await stream;
    expect(executed).toEqual([]);
    const toolResult = rowsOfType(harness, sessionId, 'tool/result')[0].payload as EventPayloadMap['tool/result'];
    expect(toolResult).toMatchObject({ status: 'error' });
    expect((toolResult.result as { error: string }).error).toBe('APPROVAL_DENIED');
  });
});

describe('chat stream: cancel, steering, regenerate', () => {
  it('cancel mid-stream settles the turn as cancelled, never as an error', async () => {
    const { harness } = await buildTestHarness([[text('đang làm...'), waitAbort()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const stream = openStream(app, '/api/chat/stream', { sessionId, message: 'Dài quá, dừng lại' });
    await expect.poll(() => harness.busy(sessionId), { timeout: 3000 }).toBe(true);

    const cancelled = await api(app).post('/api/chat/cancel').send({ sessionId });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ sessionId, cancelled: true });

    const frames = sseFrames((await stream).text);
    expect(framesOfType(frames, 'turn/end')[0].payload.reason).toBe('cancelled');
    expect(framesOfType(frames, 'error')).toHaveLength(0);
    expect(statusFrames(frames)).toContain('cancelled');
    expect(harness.busy(sessionId)).toBe(false);
    // The cancelled partial survives as an attempt row, exactly as the loop persists it.
    expect(rowsOfType(harness, sessionId, 'assistant/attempt')).toHaveLength(1);
  });

  it('cancelling an idle session is a no-op, not an error', async () => {
    const { harness } = await buildTestHarness([[stop()]]);
    const app = buildApp(harness);
    const res = await api(app).post('/api/chat/cancel').send({ sessionId: 'sess_nobody' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'sess_nobody', cancelled: false });
  });

  it('a message during a running turn is steered into the inbox, not a second stream', async () => {
    const { harness } = await buildTestHarness([[text('đang chạy'), waitAbort()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const stream = openStream(app, '/api/chat/stream', { sessionId, message: 'Turn đầu' });
    await expect.poll(() => harness.busy(sessionId), { timeout: 3000 }).toBe(true);

    const queued = await api(app).post('/api/chat/stream').send({ sessionId, message: '  steer ngay  ' });
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ queued: true, position: 1, message: 'steer ngay' });
    expect(queued.headers['content-type']).toContain('application/json');
    expect(harness.inbox.size(sessionId)).toBe(1);

    // The queue card's dismiss drops the wait server-side; drained steers would be unaffected.
    const cleared = await api(app).post('/api/chat/queue/clear').send({ sessionId });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ sessionId, cleared: 1 });
    expect(harness.inbox.size(sessionId)).toBe(0);
    // Empty again: clearing is an idempotent no-op, not an error.
    const clearedAgain = await api(app).post('/api/chat/queue/clear').send({ sessionId });
    expect(clearedAgain.body).toEqual({ sessionId, cleared: 0 });

    // A regenerate is never steering: the busy session refuses it outright, before any turn starts.
    const refused = await api(app).post('/api/chat/regenerate').send({ sessionId, assistantMessageId: 'msg_whatever' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SESSION_BUSY');
    expect(refused.body.error.message).toBe('phiên đang bận');

    await api(app).post('/api/chat/cancel').send({ sessionId });
    await stream;
    // The steer was queued, not started: only the first turn's user message was ever persisted.
    expect(rowsOfType(harness, sessionId, 'user/message')).toHaveLength(1);
  });

  it('regenerate supersedes the old answer without duplicating the user message', async () => {
    const { harness } = await buildTestHarness([[text('Trả lời 1'), stop()], [text('Trả lời 2'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    await runStream(app, sessionId, 'Viết helper');
    const firstAssistant = rowsOfType(harness, sessionId, 'assistant/message')[0].payload as EventPayloadMap['assistant/message'];

    const res = await openStream(app, '/api/chat/regenerate', { sessionId, assistantMessageId: firstAssistant.messageId });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    const frames = sseFrames(res.text);

    const turnStart = framesOfType(frames, 'turn/start')[0];
    expect(turnStart.payload).toMatchObject({
      trigger: 'regenerate',
      regeneratedFrom: { userMessageId: expect.any(String), supersedesAssistantMessageId: firstAssistant.messageId },
    });
    expect(framesOfType(frames, 'assistant/delta').map((frame) => frame.payload.text)).toEqual(['Trả lời 2']);

    expect(rowsOfType(harness, sessionId, 'user/message')).toHaveLength(1);
    const detail = await api(app).get(`/api/sessions/${sessionId}`);
    expect(detail.body.messages.map((message: { role: string; content: string }) => [message.role, message.content])).toEqual([
      ['user', 'Viết helper'],
      ['assistant', 'Trả lời 2'],
    ]);
    expect(detail.body.messages[1].id).not.toBe(firstAssistant.messageId);
  });

  it('regenerate 404s an unknown assistant message', async () => {
    const { harness } = await buildTestHarness([[stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const unknown = await api(app).post('/api/chat/regenerate').send({ sessionId, assistantMessageId: 'msg_ghost' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('regenerate refuses a user message id without anchoring or superseding anything', async () => {
    const { harness } = await buildTestHarness([[text('Trả lời 1'), stop()], [text('Trả lời 2'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    await runStream(app, sessionId, 'Câu 1');
    await runStream(app, sessionId, 'Câu 2');
    const turnStartsBefore = rowsOfType(harness, sessionId, 'turn/start').length;
    const turnRowsBefore = turnRows(harness, sessionId).length;
    const secondUser = rowsOfType(harness, sessionId, 'user/message')[1].payload as EventPayloadMap['user/message'];

    const refused = await api(app).post('/api/chat/regenerate').send({ sessionId, assistantMessageId: secondUser.messageId });
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe('MESSAGE_NOT_FOUND');
    // The unified envelope, JSON and nothing else in it (Task 18 ruling 2).
    expect(refused.headers['content-type']).toContain('application/json');
    expect(refused.body).toEqual({ error: { code: 'MESSAGE_NOT_FOUND' } });
    // The role check must reject the id outright: no turn starts, so no `regeneratedFrom` lands on
    // the projection and the user message is never added to the superseded set. Counted over the
    // whole `turn/*` family from the real store — a stray `turn/end` would leak past a per-type check.
    expect(rowsOfType(harness, sessionId, 'turn/start')).toHaveLength(turnStartsBefore);
    expect(turnRows(harness, sessionId)).toHaveLength(turnRowsBefore);
    const detail = await api(app).get(`/api/sessions/${sessionId}`);
    expect(detail.body.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(2);
  });

  it('regenerate 404s an id that is not in the session, and writes no turn rows for it', async () => {
    const { harness } = await buildTestHarness([[text('Trả lời 1'), stop()], [text('Trả lời 2'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);
    await runStream(app, sessionId, 'Câu 1');

    // The second id is real — just not in this session: the lookup is session-scoped, so both ids
    // take the same `index === -1` return and both owe the client the same per-code 404.
    const otherSessionId = makeSession(harness);
    await runStream(app, otherSessionId, 'Câu của phiên khác');
    const foreignAssistant = rowsOfType(harness, otherSessionId, 'assistant/message')[0].payload as EventPayloadMap['assistant/message'];

    const turnRowsBefore = turnRows(harness, sessionId).length;
    const otherTurnRowsBefore = turnRows(harness, otherSessionId).length;

    for (const assistantMessageId of ['msg_ghost', foreignAssistant.messageId]) {
      const refused = await api(app).post('/api/chat/regenerate').send({ sessionId, assistantMessageId });
      expect(refused.status).toBe(404);
      expect(refused.body).toEqual({ error: { code: 'MESSAGE_NOT_FOUND' } });
      expect(refused.headers['content-type']).toContain('application/json');
    }

    // Refused before any turn is built: neither session gained a `turn/*` row, and the anchored
    // session still holds exactly its one user message.
    expect(turnRows(harness, sessionId)).toHaveLength(turnRowsBefore);
    expect(turnRows(harness, otherSessionId)).toHaveLength(otherTurnRowsBefore);
    expect(rowsOfType(harness, sessionId, 'user/message')).toHaveLength(1);
  });
});

describe('chat stream: client disconnect', () => {
  it('releases the registry entry, the ping interval and the response when the client closes before turn/end', async () => {
    const { harness } = await buildTestHarness([[text('đang làm...'), waitAbort()]]);
    // The client is gone before the route cleans up, so the test records the server-side response
    // through a probe middleware and asserts for itself that the route ended it.
    const responses: Response[] = [];
    const app = createApp({
      token: TOKEN,
      version: '1.1.0',
      mount: (router) => {
        router.use((req, res, next) => {
          if (req.path.startsWith('/api/chat/stream')) responses.push(res);
          next();
        });
        mountRoutes(router, harness);
      },
    });
    const sessionId = makeSession(harness);

    // The keep-alive interval is one of the resources the `finally` owns. Fake timers cannot wrap a
    // real HTTP round trip (they starve the socket), so the ping is pinned at the timer pair: the
    // interval this stream created is the interval that has to be cleared.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { call, closed } = startStream(app, { sessionId, message: 'Đóng trước turn/end' });
    await expect.poll(() => harness.busy(sessionId), { timeout: 3000 }).toBe(true);
    // The close really lands before the terminal row exists, not after it.
    expect(rowsOfType(harness, sessionId, 'turn/end')).toHaveLength(0);

    call.abort();
    const partial = await closed;
    expect(partial.status).toBe(200);
    // The client was mid-stream — it read the opening frame and then lost the connection, so the
    // terminal frame it never saw is the whole point of the cleanup assertions below.
    expect(framesOfType(sseFrames(partial.text), 'turn/start')).toHaveLength(1);
    expect(framesOfType(sseFrames(partial.text), 'turn/end')).toHaveLength(0);

    // Fix round 3: the disconnect now tears the turn down on its own — the route aborts through
    // `res.on('close')`, `runTurn` returns, and the `finally` releases the registry entry. By the
    // time this cancel lands the session is idle again, so the cooperative stop is an idempotent
    // no-op (contrast the round-2 stopgap, which had to cancel to un-stick the dead `req` handler).
    expect((await api(app).post('/api/chat/cancel').send({ sessionId })).body).toEqual({ sessionId, cancelled: false });

    await expect.poll(() => harness.cancellations.has(sessionId)).toBe(false);
    await expect.poll(() => harness.busy(sessionId)).toBe(false);
    await expect.poll(() => responses.length === 1 && responses.every((res) => res.writableEnded), { timeout: 3000 }).toBe(true);
    expect(rowsOfType(harness, sessionId, 'turn/end')[0]?.payload).toMatchObject({ reason: 'cancelled' });

    const pingTimers: unknown[] = [];
    setIntervalSpy.mock.results.forEach((result, index) => {
      if (result.type === 'return' && setIntervalSpy.mock.calls[index]?.[1] === SSE_PING_INTERVAL_MS) pingTimers.push(result.value);
    });
    expect(pingTimers).not.toHaveLength(0);
    const clearedTimers = clearIntervalSpy.mock.calls.map((args) => args[0]);
    for (const timer of pingTimers) {
      expect(clearedTimers).toContain(timer);
    }
  });

  /**
   * Pins the defect Round 2 reported but did not fix: the disconnect by itself must tear the turn
   * down. A tool that awaits an external promise parks the loop between its first and second
   * provider attempts, so the ONLY way `cancellations.has` and `busy` can flip to false is for the
   * close to abort the turn and let the `finally` release the registry (Task 18 ruling 8's
   * requirement, dead until the route listens on `res` instead of the already-consumed `req`). The
   * provider-attempt counter then proves the aborted turn really stopped paying a client that is
   * gone. The client-side `await` on the response body is the awkward supertest part, so the close
   * is pinned through a server-captured response and the real durable rows instead.
   */
  it('tears the turn down when the client closes mid-tool without calling cancel', async () => {
    let releaseGate: () => void = () => {};
    const gateHeld = new Promise<void>((resolve) => { releaseGate = resolve; });
    const { harness, adapter } = await buildTestHarness([
      callsStep('call_1', 'park_tool'),
      [text('chạy tiếp'), stop()],
    ]);
    harness.tools.register(
      toolDefinition('park_tool', 'auto', 'low', async () => {
        await gateHeld;
        return { ok: true };
      }),
    );
    // The client is gone before the route cleans up, so record the server-side response through a
    // probe middleware and assert the route actually ended it.
    const responses: Response[] = [];
    const app = createApp({
      token: TOKEN,
      version: '1.1.0',
      mount: (router) => {
        router.use((req, res, next) => {
          if (req.path.startsWith('/api/chat/stream')) responses.push(res);
          next();
        });
        mountRoutes(router, harness);
      },
    });
    const sessionId = makeSession(harness);

    const { call } = startStream(app, { sessionId, message: 'Đóng giữa chừng' });
    // Parked: attempt #1 called the provider once and dispatched the tool; the loop now sits inside
    // `await pipeline.run(...)`, so no second attempt has begun and no terminal row exists yet.
    await expect
      .poll(
        () =>
          harness.busy(sessionId)
          && adapter.requests.length === 1
          && rowsOfType(harness, sessionId, 'tool/call').length === 1
          && rowsOfType(harness, sessionId, 'turn/end').length === 0,
        { timeout: 3000 },
      )
      .toBe(true);

    try {
      // Close the client socket WITHOUT POST /api/chat/cancel — the whole point of the fix.
      call.abort();

      // The disconnect alone must tear the turn down: registry and busy both released.
      await expect.poll(() => harness.cancellations.has(sessionId), { timeout: 1500 }).toBe(false);
      await expect.poll(() => harness.busy(sessionId), { timeout: 1500 }).toBe(false);
      // The route owns every release, so the response it was still writing is ended too.
      await expect.poll(() => responses.length === 1 && responses[0].writableEnded, { timeout: 1500 }).toBe(true);
    } finally {
      // Always free the parked tool so a failing run does not leave the loop hanging on a closed db.
      releaseGate();
      // Let the turn finish unwinding (and its durable rows land) before afterEach closes the db.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Torn down cooperatively, not completed: exactly one provider attempt, one step, cancelled.
    expect(adapter.requests).toHaveLength(1);
    expect(rowsOfType(harness, sessionId, 'step/start')).toHaveLength(1);
    expect(rowsOfType(harness, sessionId, 'assistant/message').map((row) => (row.payload as EventPayloadMap['assistant/message']).content)).not.toContain('chạy tiếp');
    expect(rowsOfType(harness, sessionId, 'turn/end')[0]?.payload).toMatchObject({ reason: 'cancelled' });
  });
});

describe('chat stream: failure and residual contracts', () => {
  it('a memory clear under a live turn ends the stream with an error, not a crash', async () => {
    const { harness } = await buildTestHarness([[text('trước khi xóa'), waitAbort()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const stream = openStream(app, '/api/chat/stream', { sessionId, message: 'Xóa memory giữa turn' });
    await expect.poll(() => harness.busy(sessionId), { timeout: 3000 }).toBe(true);

    expect((await api(app).del('/api/memory')).status).toBe(200);

    const frames = sseFrames((await stream).text);
    const errors = framesOfType(frames, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.code).toBe('AGENT_ERROR');
    // The terminal frame is synthetic — the row never persisted, so it carries no seq.
    const turnEnd = framesOfType(frames, 'turn/end');
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0].payload.reason).toBe('error');
    expect(turnEnd[0].seq).toBeUndefined();

    // The process survived: the server still answers, and the registry released the session.
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect(harness.busy(sessionId)).toBe(false);
  });

  it('suppresses replayed live deltas after a retried attempt while the durable row stays authoritative', async () => {
    // The 500 ms first retry backoff is paid for real; one test at that length is the honest price
    // of pinning the provisional-delta contract instead of faking the retry seam.
    const { harness } = await buildTestHarness([[text('nửa đầu'), providerError('flaky')], [text('toàn văn'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const frames = await runStream(app, sessionId, 'Provider chập chờn');

    expect(framesOfType(frames, 'assistant/delta').map((frame) => frame.payload.text)).toEqual(['nửa đầu']);
    expect(framesOfType(frames, 'assistant/attempt')).toHaveLength(1);
    const assistant = rowsOfType(harness, sessionId, 'assistant/message')[0].payload as EventPayloadMap['assistant/message'];
    expect(assistant.content).toBe('toàn văn');
    expect(framesOfType(frames, 'turn/end')[0].payload.reason).toBe('completed');
  });

  it('names a still-default session from the first message', async () => {
    const { harness } = await buildTestHarness([[text('Vẽ wave spawner'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness, DEFAULT_TITLE);

    await runStream(app, sessionId, 'Vẽ wave spawner cho map của tôi');

    await expect.poll(() => rowsOfType(harness, sessionId, 'session/title').length, { timeout: 3000 }).toBe(1);
    const titled = rowsOfType(harness, sessionId, 'session/title')[0];
    expect(titled.payload).toMatchObject({ source: 'auto' });
    expect(harness.sessions.get(sessionId)?.title).toBe(titled.payload.title);
  });

  it('pins the parseArgs ruling: corrupt streamed args settle INVALID_ARGS through AJV', async () => {
    const strictExecuted: unknown[] = [];
    const looseExecuted: unknown[] = [];
    const { harness } = await buildTestHarness([
      corruptCallStep('call_strict', 'strict_tool'),
      [text('xong 1'), stop()],
      corruptCallStep('call_loose', 'loose_tool'),
      [text('xong 2'), stop()],
    ]);
    const app = buildApp(harness);
    harness.tools.register(toolDefinition('strict_tool', 'auto', 'low', async (args) => {
      strictExecuted.push(args);
      return { ok: true };
    }, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }));
    // The MCP mirror shape Task 14 accepts: an object schema that declares nothing.
    harness.tools.register(toolDefinition('loose_tool', 'auto', 'low', async (args) => {
      looseExecuted.push(args);
      return { ok: true };
    }, { type: 'object' }));

    const sessionId = makeSession(harness);
    await runStream(app, sessionId, 'gọi tool thiếu tham số');
    const strictResult = rowsOfType(harness, sessionId, 'tool/result')[0].payload as EventPayloadMap['tool/result'];
    expect(strictResult).toMatchObject({ callId: 'call_strict', status: 'error' });
    expect((strictResult.result as { error: string }).error).toBe('INVALID_ARGS');
    expect(strictExecuted).toEqual([]);

    const projectId = harness.projects.list()[0].id;
    const secondSession = harness.sessions.create(projectId, 'Second');
    await runStream(app, secondSession.id, 'gọi tool mcp không required');
    const looseResult = rowsOfType(harness, secondSession.id, 'tool/result')[0].payload as EventPayloadMap['tool/result'];
    expect(looseResult).toMatchObject({ callId: 'call_loose', status: 'done' });
    // Accepted residual, pinned by the Task 16 ruling: an unparseable argument blob degrades to an
    // empty-args call whenever the schema has no required properties to reject it.
    expect(looseExecuted).toEqual([{}]);
  });
});

describe('chat stream: image attachments', () => {
  const image = { name: 'shot.png', mime: 'image/png', size: 5, data: 'aGVsbG8=' };

  it('accepts an image-only turn and carries the pixels to the model', async () => {
    const { harness, adapter } = await buildTestHarness([[text('đã xem ảnh'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const frames = await runStream(app, sessionId, '', { attachments: [image] });

    const userRows = rowsOfType(harness, sessionId, 'user/message');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].payload).toMatchObject({
      content: '',
      attachments: [{ name: 'shot.png', mime: 'image/png', size: 5 }],
    });
    const lastRequest = adapter.requests[adapter.requests.length - 1];
    const lastUser = [...lastRequest.messages].reverse().find((message) => message.role === 'user');
    expect(lastUser?.imageParts).toEqual([{ mime: 'image/png', data: 'aGVsbG8=' }]);
    expect(framesOfType(frames, 'turn/end')[0].payload.reason).toBe('completed');
  });

  it('still rejects an empty message when no attachment rides along', async () => {
    const { harness } = await buildTestHarness([[text('ok'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    const res = await openStream(app, '/api/chat/stream', { sessionId, message: '   ' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(turnRows(harness, sessionId)).toHaveLength(0);
  });

  it('keeps text and pixels together when both are present', async () => {
    const { harness, adapter } = await buildTestHarness([[text('ok'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);

    await runStream(app, sessionId, 'ảnh này là gì?', { attachments: [image] });

    const userRows = rowsOfType(harness, sessionId, 'user/message');
    expect(userRows[0].payload.content).toBe('ảnh này là gì?');
    const lastRequest = adapter.requests[adapter.requests.length - 1];
    const lastUser = [...lastRequest.messages].reverse().find((message) => message.role === 'user');
    expect(lastUser?.content).toBe('ảnh này là gì?');
    expect(lastUser?.imageParts).toEqual([{ mime: 'image/png', data: 'aGVsbG8=' }]);
  });

  it('keeps the default title when the first turn is image-only', async () => {
    const { harness } = await buildTestHarness([[text('ok'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness, DEFAULT_TITLE);

    await runStream(app, sessionId, '', { attachments: [image] });

    // Auto-title runs detached from the stream; give it room to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rowsOfType(harness, sessionId, 'session/title')).toHaveLength(0);
    expect(harness.sessions.get(sessionId)?.title).toBe(DEFAULT_TITLE);
  });

  it('accepts an attachment larger than the old 2mb body cap', async () => {
    const { harness } = await buildTestHarness([[text('ok'), stop()]]);
    const app = buildApp(harness);
    const sessionId = makeSession(harness);
    const data = 'A'.repeat(3 * 1024 * 1024);

    const res = await openStream(app, '/api/chat/stream', {
      sessionId,
      message: '',
      attachments: [{ name: 'big.png', mime: 'image/png', size: 2_359_296, data }],
    });

    expect(res.status).toBe(200);
    expect(rowsOfType(harness, sessionId, 'user/message')).toHaveLength(1);
  });

  it('carries a tool screenshot into the next model request without persisting the base64', async () => {
    const { harness, adapter } = await buildTestHarness([callsStep('call_cap', 'fake_capture'), [text('đã thấy'), stop()]]);
    const app = buildApp(harness);
    harness.tools.register(toolDefinition('fake_capture', 'auto', 'low', async () => ({
      text: '[Ảnh image/png, 5 B]',
      images: [{ mime: 'image/png', data: 'aGVsbG8=' }],
    }), { type: 'object' }));
    const sessionId = makeSession(harness);

    await runStream(app, sessionId, 'chụp màn hình');

    const toolResult = rowsOfType(harness, sessionId, 'tool/result')[0].payload as EventPayloadMap['tool/result'];
    expect(toolResult.result).toBe('[Ảnh image/png, 5 B]');
    const second = adapter.requests[1];
    const lastUser = [...second.messages].reverse().find((message) => message.role === 'user');
    expect(lastUser?.imageParts).toEqual([{ mime: 'image/png', data: 'aGVsbG8=' }]);
  });
});
