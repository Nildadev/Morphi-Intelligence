import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db';
import { createEmit } from '../events/emit';
import { EventStore } from '../events/store';
import type { AgentStatus, LiveEvent } from '../shared/types';
import { effectiveWindow, toolOutputBudgetChars } from '../shared/window';
import type { Emit, EventPayloadMap, EventType, SessionEvent } from '../events/types';
import type { LlmRequest, ModelInfo, ProviderAdapter, StreamEvent } from '../llm/types';
import { LlmRegistry } from '../llm/registry';
import { ApprovalService } from '../tools/approval';
import { ToolRegistry } from '../tools/registry';
import { ToolPipeline } from '../tools/pipeline';
import type { McpGateway, ToolContext, ToolDefinition, ToolRunContext } from '../tools/types';
import { CompactionService } from '../compaction/service';
import { Inbox } from './inbox';
import { LLM_RETRY_DELAYS_MS, MAX_LLM_ATTEMPTS } from './retry';
import { AgentLoop, MAX_STEPS_PER_TURN, MAX_TOOL_CALLS_PER_STEP, TURN_TIMEOUT_MS } from './loop';
import type { AgentLoopDeps, AgentTurnInput, TurnResult } from './loop';

type TestStep = StreamEvent | { readonly wait: 'abort' };

interface CallSpec {
  id: string;
  name: string;
  args?: unknown;
}

const TEST_MODEL: ModelInfo = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'test',
  providerLabel: 'Test',
  context: 32_000,
  supportsTools: true,
};

const NO_MCP: McpGateway = {
  connected: false,
  studioLinked: false,
  server: { source: 'none', path: null, version: null },
  listTools: async () => [],
  callTool: async () => null,
  reconnect: async () => undefined,
};

const text = (value: string): StreamEvent => ({ type: 'text_delta', text: value });
const thought = (value: string): StreamEvent => ({ type: 'reasoning_delta', text: value });
const stop = (): StreamEvent => ({ type: 'finish', reason: 'stop' });
const finishError = (): StreamEvent => ({ type: 'finish', reason: 'error' });
const waitAbort = (): TestStep => ({ wait: 'abort' });
const usageEvent = (promptTokens: number, completionTokens: number): StreamEvent => ({
  type: 'usage',
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
});
const providerError = (message: string, status?: number): StreamEvent => ({
  type: 'error',
  error: { code: 'http_error', message, retryable: status === undefined ? true : status === 429 || status >= 500, ...(status === undefined ? {} : { status }) },
});

/** One provider step: every call announced and closed, then the tool_calls finish. */
function callsStep(...calls: CallSpec[]): StreamEvent[] {
  const events: StreamEvent[] = calls.flatMap((call) => [
    { type: 'tool_call_start', callId: call.id, name: call.name } as StreamEvent,
    { type: 'tool_call_end', callId: call.id, name: call.name, args: call.args ?? {} } as StreamEvent,
  ]);
  return [...events, { type: 'finish', reason: 'tool_calls' }];
}

function tool(
  name: string,
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute,
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: name, risk: 'low' },
    ...overrides,
  };
}

class ScriptedAdapter implements ProviderAdapter {
  readonly id = 'test';
  readonly name = 'Test';
  readonly requests: LlmRequest[] = [];
  private stepsFor: (index: number) => TestStep[] = () => [];
  private cursor = 0;

  constructor(
    private readonly model: ModelInfo,
    steps: TestStep[][] | ((index: number) => TestStep[]),
  ) {
    this.queue(steps);
  }

  queue(steps: TestStep[][] | ((index: number) => TestStep[])): void {
    if (typeof steps === 'function') {
      this.stepsFor = steps;
    } else {
      const script = steps;
      this.stepsFor = (index) => script[Math.min(index, script.length - 1)] ?? [];
    }
    this.cursor = 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [this.model];
  }

  stream(request: LlmRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const steps = this.stepsFor(this.cursor);
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

interface FixtureOptions {
  steps?: TestStep[][];
  stepsFor?: (index: number) => TestStep[];
  tools?: ToolDefinition[];
  context?: number;
  model?: Partial<ModelInfo>;
  credentials?: Record<string, string>;
  inbox?: Inbox;
  prompt?: NonNullable<AgentLoopDeps['prompt']>;
  complete?: (prompt: string, model: string) => Promise<string>;
}

interface Fixture {
  db: Database.Database;
  events: EventStore;
  adapter: ScriptedAdapter;
  registry: ToolRegistry;
  pipeline: ToolPipeline;
  approval: ApprovalService;
  inbox: Inbox;
  compaction: CompactionService;
  loop: AgentLoop;
  live: LiveEvent[];
  emit: Emit;
  rows: () => SessionEvent[];
  types: () => EventType[];
  payloads: <K extends EventType>(type: K) => EventPayloadMap[K][];
  turnId: () => string;
  turn: (overrides?: Partial<AgentTurnInput>, signal?: AbortSignal) => Promise<TurnResult>;
}

let openDb: Database.Database | undefined;

afterEach(() => {
  openDb?.close();
  openDb = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = createTestDb();
  openDb = db;
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'Project', 1, 1);
  db.prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)').run('s1', 'p1', 'Session', 1, 1);

  const events = new EventStore(db);
  const model: ModelInfo = { ...TEST_MODEL, ...(options.model ?? {}), ...(options.context === undefined ? {} : { context: options.context }) };
  const adapter = new ScriptedAdapter(model, options.stepsFor ?? options.steps ?? [[]]);
  const llm = new LlmRegistry([adapter]);
  llm.setCredentials(options.credentials ?? { test: 'test-key' });
  await llm.refreshModels();

  const registry = new ToolRegistry(options.tools ?? []);
  const approval = new ApprovalService();
  const pipeline = new ToolPipeline(registry, approval);
  const inbox = options.inbox ?? new Inbox();
  const compaction = new CompactionService({
    events,
    complete: options.complete ?? (async () => 'SESSION SUMMARY'),
    model: 'test-model',
    config: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 2 },
  });
  const loop = new AgentLoop({
    events,
    llm,
    tools: registry,
    pipeline,
    compaction,
    inbox,
    mcp: NO_MCP,
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });

  const live: LiveEvent[] = [];
  const emit = createEmit(events, 's1', (event) => {
    if (!('seq' in event)) live.push(event);
  });

  const rows = () => events.list('s1');
  return {
    db,
    events,
    adapter,
    registry,
    pipeline,
    approval,
    inbox,
    compaction,
    loop,
    live,
    emit,
    rows,
    types: () => rows().map((row) => row.type),
    payloads: <K extends EventType>(type: K) =>
      rows().filter((row) => row.type === type).map((row) => row.payload as EventPayloadMap[K]),
    turnId: () => rows()[0].payload.turnId as string,
    turn: (overrides: Partial<AgentTurnInput> = {}, signal?: AbortSignal) =>
      loop.runTurn(
        {
          sessionId: 's1',
          content: 'hello',
          modelSelection: 'test-model',
          trigger: 'user',
          signal: signal ?? new AbortController().signal,
          ...overrides,
        },
        emit,
      ),
  };
}

function statusStates(live: LiveEvent[]): AgentStatus[] {
  return live
    .filter((event): event is Extract<LiveEvent, { type: 'agent/status' }> => event.type === 'agent/status')
    .map((event) => event.payload.state);
}

function errorPayloads(live: LiveEvent[]): Extract<LiveEvent, { type: 'error' }>['payload'][] {
  return live
    .filter((event): event is Extract<LiveEvent, { type: 'error' }> => event.type === 'error')
    .map((event) => event.payload);
}

function assistantDeltas(live: LiveEvent[]): string[] {
  return live
    .filter((event): event is Extract<LiveEvent, { type: 'assistant/delta' }> => event.type === 'assistant/delta')
    .map((event) => event.payload.text);
}

function progressMessages(live: LiveEvent[]): string[] {
  return live
    .filter((event): event is Extract<LiveEvent, { type: 'tool/progress' }> => event.type === 'tool/progress')
    .map((event) => event.payload.message);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

/** Let every queued microtask/timer callback run so a pending durable event lands. */
async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AgentLoop text-only turn', () => {
  it('records the durable event sequence and streams live deltas', async () => {
    const f = await fixture({ steps: [[text('hi'), stop()]] });

    await expect(f.turn()).resolves.toEqual({ turnId: expect.any(String), status: 'completed' });

    expect(f.types()).toEqual(['turn/start', 'user/message', 'step/start', 'assistant/message', 'turn/end']);
    const [turnStart] = f.payloads('turn/start');
    expect(turnStart).toEqual({ turnId: expect.stringMatching(/^turn_/), modelSelection: 'test-model', trigger: 'user' });
    expect(f.payloads('user/message')).toEqual([
      { messageId: expect.stringMatching(/^msg_/), content: 'hello', source: 'user' },
    ]);
    expect(f.payloads('step/start')).toEqual([{ stepId: expect.stringMatching(/^step_/), index: 0 }]);
    const [assistant] = f.payloads('assistant/message');
    expect(assistant).toEqual({
      messageId: expect.stringMatching(/^msg_/),
      content: 'hi',
      finishReason: 'stop',
      callIds: [],
      activity: [{ kind: 'text', text: 'hi' }],
    });
    expect('usage' in assistant).toBe(false);
    expect('reasoning' in assistant).toBe(false);
    expect(f.payloads('turn/end')).toEqual([{ turnId: turnStart.turnId, reason: 'completed' }]);
    expect(f.live).toEqual([
      { type: 'agent/status', payload: { state: 'thinking', turnId: turnStart.turnId } },
      { type: 'assistant/delta', payload: { turnId: turnStart.turnId, text: 'hi' } },
      { type: 'agent/status', payload: { state: 'idle', turnId: turnStart.turnId } },
    ]);
    expect(statusStates(f.live)).toEqual(['thinking', 'idle']);
  });

  it('records the user message exactly once and hands it to the provider through compaction', async () => {
    const f = await fixture({ steps: [[text('hi'), stop()]] });

    await f.turn();

    expect(f.payloads('user/message')).toHaveLength(1);
    const messages = f.adapter.requests[0].messages;
    expect(messages.filter((message) => message.role === 'user')).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('streams reasoning deltas and stores provider usage when it is reported', async () => {
    const f = await fixture({ steps: [[thought('thinking hard'), usageEvent(120, 30), text('hi'), stop()]] });

    await f.turn();

    const [assistant] = f.payloads('assistant/message');
    expect(assistant).toMatchObject({
      content: 'hi',
      reasoning: 'thinking hard',
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    });
    expect(f.live.filter((event) => event.type === 'thought/delta')).toEqual([
      { type: 'thought/delta', payload: { turnId: f.turnId(), text: 'thinking hard' } },
    ]);
  });

  it('records no assistant message when the provider produced nothing', async () => {
    const f = await fixture({ steps: [[stop()]] });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    expect(f.types()).toEqual(['turn/start', 'user/message', 'step/start', 'turn/end']);
  });

  it('sends the assembled prompt first and keeps the compaction system messages after it', async () => {
    const f = await fixture({
      steps: [[text('sure'), stop()]],
      prompt: () => ({ instructions: 'Prefer ModuleScripts.' }),
    });
    f.events.append('s1', [
      { type: 'turn/start', payload: { turnId: 'turn_old', modelSelection: 'test-model', trigger: 'user' } },
      { type: 'user/message', payload: { messageId: 'msg_old', content: 'first question', source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'msg_old_a', content: 'first answer', finishReason: 'stop', callIds: [] } },
      { type: 'compaction/summary', payload: { summary: 'EARLIER SUMMARY', coveredFrom: 1, coveredTo: 3, tokenEstimate: 4 } },
      { type: 'goal/changed', payload: { goalId: 'goal_1', status: 'active', objective: 'Ship the lobby' } },
    ]);

    await f.turn();

    const messages = f.adapter.requests[0].messages;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('## Identity');
    expect(messages[0].content).toContain('## Tool policy');
    expect(messages[0].content).toContain('- Goal: Ship the lobby');
    expect(messages[0].content).toContain('Prefer ModuleScripts.');
    expect(messages[1]).toEqual({ role: 'system', content: 'EARLIER SUMMARY' });
    expect(messages.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('passes the registry tool schemas and the chosen effort to the provider', async () => {
    const f = await fixture({ steps: [[text('hi'), stop()]], tools: [tool('alpha', async () => 'a'), tool('beta', async () => 'b')] });

    await f.turn({ effort: 'high' });

    const request = f.adapter.requests[0];
    expect(request.model).toBe('test-model');
    // The old flag was a boolean nobody read; this one names the level the adapters map to their
    // own knob (`thinkingBudget` / `reasoning_effort`).
    expect(request.effort).toBe('high');
    expect(request.tools).toHaveLength(2);
    expect(request.tools.map((schema) => schema.name)).toEqual(['alpha', 'beta']);
    expect(request.signal.aborted).toBe(false);
  });

  it('appends no user message for a regenerated turn and snapshots regeneratedFrom', async () => {
    const f = await fixture({ steps: [[text('fresh answer'), stop()]] });

    await f.turn({
      content: undefined,
      trigger: 'regenerate',
      regeneratedFrom: { userMessageId: 'msg_u', supersedesAssistantMessageId: 'msg_a' },
    });

    expect(f.types()).toEqual(['turn/start', 'step/start', 'assistant/message', 'turn/end']);
    expect(f.payloads('turn/start')[0]).toEqual({
      turnId: expect.stringMatching(/^turn_/),
      modelSelection: 'test-model',
      trigger: 'regenerate',
      regeneratedFrom: { userMessageId: 'msg_u', supersedesAssistantMessageId: 'msg_a' },
    });
  });

  it('ends with NO_PROVIDER without calling any adapter when none is configured', async () => {
    const f = await fixture({ steps: [[text('hi'), stop()]], credentials: {} });
    const release = vi.spyOn(f.pipeline, 'releaseSession');

    await expect(f.turn()).resolves.toMatchObject({ status: 'error' });

    // The model is resolved before the first step, so no step row is written at all.
    expect(f.types()).toEqual(['turn/start', 'user/message', 'turn/end']);
    expect(errorPayloads(f.live)).toEqual([{ code: 'NO_PROVIDER', message: expect.any(String), retryable: false }]);
    expect(f.payloads('turn/end')[0].reason).toBe('error');
    expect(statusStates(f.live)).toEqual(['thinking', 'idle']);
    expect(f.adapter.requests).toHaveLength(0);
    expect(release).toHaveBeenCalledWith('s1');
  });

  it('ends with one error turn when wiring throws outside the step loop', async () => {
    const f = await fixture({ steps: [[text('hi'), stop()]] });
    const release = vi.spyOn(f.pipeline, 'releaseSession');
    vi.spyOn(f.compaction, 'buildContext').mockRejectedValue(new Error('boom'));

    await expect(f.turn()).resolves.toMatchObject({ status: 'error' });

    // `buildContext` is awaited after `step/start`, so the throw escapes `runSteps` into the
    // outer catch: the turn still appends exactly one `turn/end`, never an assistant message.
    expect(f.types()).toEqual(['turn/start', 'user/message', 'step/start', 'turn/end']);
    expect(f.payloads('turn/end')).toEqual([{
      turnId: expect.stringMatching(/^turn_/),
      reason: 'error',
      error: { code: 'AGENT_ERROR', message: 'boom', retryable: false },
    }]);
    expect(errorPayloads(f.live)).toEqual([{ code: 'AGENT_ERROR', message: 'boom', retryable: false }]);
    expect(statusStates(f.live)).toEqual(['thinking', 'idle']);
    expect(f.adapter.requests).toHaveLength(0);
    expect(release).toHaveBeenCalledWith('s1');
  });
});

describe('AgentLoop tool turn', () => {
  it('runs the batch, records call and result rows, and continues with a second step', async () => {
    const f = await fixture({
      steps: [[text('checking'), ...callsStep({ id: 'c1', name: 'read_x', args: { path: 'S1' } })], [text('done'), stop()]],
      tools: [tool('read_x', async () => ({ text: 'SOURCE' }))],
    });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    expect(f.types()).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/start',
      'assistant/message',
      'turn/end',
    ]);
    expect(f.payloads('step/start').map((payload) => payload.index)).toEqual([0, 1]);
    expect(f.payloads('assistant/message')).toEqual([
      { messageId: expect.any(String), content: 'checking', finishReason: 'tool_calls', callIds: ['c1'], activity: [{ kind: 'text', text: 'checking' }, { kind: 'call', callId: 'c1' }] },
      { messageId: expect.any(String), content: 'done', finishReason: 'stop', callIds: [], activity: [{ kind: 'text', text: 'done' }] },
    ]);
    expect(f.payloads('tool/call')[0]).toMatchObject({ callId: 'c1', name: 'read_x', args: { path: 'S1' } });
    expect(f.payloads('tool/result')[0]).toMatchObject({ callId: 'c1', status: 'done', result: { text: 'SOURCE' } });

    const second = f.adapter.requests[1].messages;
    expect(second[second.length - 1]).toEqual({ role: 'tool', toolCallId: 'c1', content: '{"text":"SOURCE"}' });
    expect(second[second.length - 2].toolCalls).toEqual([{ id: 'c1', name: 'read_x', args: { path: 'S1' } }]);
    expect(statusStates(f.live)).toEqual(['thinking', 'tool', 'thinking', 'idle']);
    expect(progressMessages(f.live)).toEqual(['read_x completed']);
  });

  it('offers only the tool schemas that fit a small window', async () => {
    // A 20 000-character description is ~5k tokens of schema: on a 2k-context model it cannot be
    // advertised at all, and offering it is what used to kill the turn before the model spoke.
    const huge = { ...tool('huge', async () => 'x'), description: 'd'.repeat(20_000) };
    const f = await fixture({
      // 8k context -> 6.4k window. The base prompt (identity, safety, environment, skills, the tool
      // list) is already a few thousand tokens, so the 5k-token schema cannot join it — that is the
      // whole point: the surface shrinks with the model instead of failing the turn.
      context: 8_000,
      steps: [[text('hi'), stop()]],
      tools: [tool('small', async () => 'ok'), huge],
    });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    expect(f.adapter.requests[0].tools.map((schema) => schema.name)).toEqual(['small']);
  });

  it('trims a huge tool result to what this model window can afford', async () => {
    // An 8k model cannot hold a 20 000-character tool answer: the budget is derived from the window,
    // not from a flat 50k ceiling that was written for large models.
    const f = await fixture({
      context: 8_000,
      steps: [
        [text('big'), ...callsStep({ id: 'c1', name: 'big', args: {} })],
        [text('done'), stop()],
      ],
      tools: [tool('big', async () => 'x'.repeat(20_000))],
    });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    const budget = toolOutputBudgetChars(effectiveWindow(8_000));
    const toolMessage = f.adapter.requests[1].messages.at(-1);
    expect(toolMessage.role).toBe('tool');
    expect((toolMessage.content ?? '').length).toBeLessThanOrEqual(budget + 200);
    expect(toolMessage.content).toContain('đã cắt bớt');
  });

  it('leaves the same result intact when the model window is large', async () => {
    const f = await fixture({
      context: 200_000,
      steps: [
        [text('big'), ...callsStep({ id: 'c1', name: 'big', args: {} })],
        [text('done'), stop()],
      ],
      tools: [tool('big', async () => 'x'.repeat(20_000))],
    });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    const toolMessage = f.adapter.requests[1].messages.at(-1);
    expect(toolMessage.content).not.toContain('đã cắt bớt');
    expect((toolMessage.content ?? '').length).toBeGreaterThan(19_000);
  });

  it('runs a multi-call step as one batch and replays both results to the provider', async () => {
    const f = await fixture({
      steps: [
        [text('two at once'), ...callsStep({ id: 'c1', name: 'first', args: { n: 1 } }, { id: 'c2', name: 'second', args: { n: 2 } })],
        [text('done'), stop()],
      ],
      tools: [tool('first', async () => 'ONE'), tool('second', async () => 'TWO')],
    });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    expect(f.types().filter((type) => type === 'step/start')).toHaveLength(2);
    expect(f.payloads('assistant/message')[0].callIds).toEqual(['c1', 'c2']);
    expect(f.payloads('tool/call').map((payload) => payload.callId)).toEqual(['c1', 'c2']);
    expect(f.payloads('tool/result').map((payload) => [payload.callId, payload.status]).sort()).toEqual([
      ['c1', 'done'],
      ['c2', 'done'],
    ]);
    expect(progressMessages(f.live).sort()).toEqual(['first completed', 'second completed']);

    const tail = f.adapter.requests[1].messages.slice(-3);
    expect(tail.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool']);
    expect(tail[0].toolCalls).toEqual([
      { id: 'c1', name: 'first', args: { n: 1 } },
      { id: 'c2', name: 'second', args: { n: 2 } },
    ]);
    expect(tail[1]).toEqual({ role: 'tool', toolCallId: 'c1', content: JSON.stringify('ONE') });
    expect(tail[2]).toEqual({ role: 'tool', toolCallId: 'c2', content: JSON.stringify('TWO') });
  });

  it('hands the tool a per-call context built from the turn and forwards its own progress', async () => {
    let seen: ToolContext | undefined;
    let args: unknown;
    const f = await fixture({
      steps: [
        [
          { type: 'tool_call_start', callId: 'c1', name: 'capture' },
          { type: 'tool_call_delta', callId: 'c1', argsDelta: '{"path":"S' },
          { type: 'tool_call_delta', callId: 'c1', argsDelta: '1"}' },
          { type: 'tool_call_end', callId: 'c1', name: 'capture', args: undefined },
          { type: 'finish', reason: 'tool_calls' },
        ],
        [text('ok'), stop()],
      ],
      tools: [
        tool('capture', async (received, ctx) => {
          args = received;
          seen = ctx;
          ctx.emit.live({ type: 'tool/progress', payload: { callId: ctx.callId, message: 'still working' } });
          return 'fine';
        }),
      ],
    });

    await f.turn();

    expect(args).toEqual({ path: 'S1' });
    expect(seen).toMatchObject({ sessionId: 's1', turnId: f.turnId(), stepId: f.payloads('step/start')[0].stepId, callId: 'c1' });
    expect(seen?.mcp).toBe(NO_MCP);
    expect(progressMessages(f.live)).toEqual(['still working', 'capture completed']);
  });

  it('closes waiting_approval back to tool once the decision lands', async () => {
    const f = await fixture({
      steps: [[text('writing'), ...callsStep({ id: 'c1', name: 'edit', args: { path: 'S1' } })], [text('done'), stop()]],
      tools: [tool('edit', async () => 'written', { approval: 'ask', isConcurrencySafe: false, presentation: { label: 'Edit', risk: 'medium' } })],
    });

    const running = f.turn();
    await flush();
    const request = f.payloads('approval/request')[0];
    expect(request).toMatchObject({ callId: 'c1', name: 'edit', risk: 'medium' });
    f.approval.decide(request.approvalId, 'allow', 'once');

    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(statusStates(f.live)).toEqual(['thinking', 'tool', 'waiting_approval', 'tool', 'thinking', 'idle']);
    expect(f.types()).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'approval/request',
      'approval/decision',
      'tool/result',
      'step/start',
      'assistant/message',
      'turn/end',
    ]);
  });

  it('stops at the step cap and ends the turn with max_steps', async () => {
    const f = await fixture({
      stepsFor: (index) => callsStep({ id: `c${index}`, name: 'loop_tool' }),
      tools: [tool('loop_tool', async () => 'again')],
    });

    await expect(f.turn()).resolves.toMatchObject({ status: 'max_steps' });

    expect(MAX_STEPS_PER_TURN).toBe(24);
    const starts = f.payloads('step/start');
    expect(starts).toHaveLength(MAX_STEPS_PER_TURN);
    expect(starts.map((payload) => payload.index)).toEqual(Array.from({ length: MAX_STEPS_PER_TURN }, (_unused, index) => index));
    expect(f.adapter.requests).toHaveLength(MAX_STEPS_PER_TURN);
    expect(f.types().filter((type) => type === 'tool/call')).toHaveLength(MAX_STEPS_PER_TURN);
    expect(f.payloads('turn/end')).toEqual([{ turnId: f.turnId(), reason: 'max_steps' }]);
    expect(statusStates(f.live).at(-1)).toBe('idle');
  });

  it('dispatches at most eight calls per step and surfaces the rest', async () => {
    const nine = Array.from({ length: 9 }, (_unused, index) => ({ id: `c${index}`, name: 'echo' }));
    const f = await fixture({ steps: [callsStep(...nine), [text('after'), stop()]], tools: [tool('echo', async () => 'ok')] });

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    expect(MAX_TOOL_CALLS_PER_STEP).toBe(8);
    expect(f.types().filter((type) => type === 'tool/call')).toHaveLength(MAX_TOOL_CALLS_PER_STEP);
    expect(f.payloads('assistant/message')[0].callIds).toHaveLength(MAX_TOOL_CALLS_PER_STEP);
    expect(errorPayloads(f.live)).toEqual([{ code: 'TOO_MANY_TOOL_CALLS', message: expect.any(String), retryable: false }]);
  });
});

describe('AgentLoop retry', () => {
  it('retries a retryable failure and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    const f = await fixture({ steps: [[providerError('temporarily down', 500), finishError()], [text('second time'), stop()]] });

    const running = f.turn();
    await vi.advanceTimersByTimeAsync(499);
    expect(f.adapter.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(f.adapter.requests).toHaveLength(2);
    expect(f.types()).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/attempt',
      'assistant/message',
      'turn/end',
    ]);
    expect(f.payloads('assistant/attempt')).toEqual([
      { attemptId: expect.stringMatching(/^attempt_/), error: 'temporarily down', retryable: true, finishedAt: expect.any(Number) },
    ]);
    expect(assistantDeltas(f.live)).toEqual(['second time']);
    expect(errorPayloads(f.live)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after ten retries and ends the turn with error', async () => {
    vi.useFakeTimers();
    const f = await fixture({ steps: [[providerError('still down', 503), finishError()]] });
    const release = vi.spyOn(f.pipeline, 'releaseSession');

    const running = f.turn();
    // The whole ten-delay schedule, paid in fake time: no attempt is left unfired.
    let backoff = 0;
    for (const delay of LLM_RETRY_DELAYS_MS) backoff += delay;
    await vi.advanceTimersByTimeAsync(backoff);
    await expect(running).resolves.toMatchObject({ status: 'error' });

    expect(f.adapter.requests).toHaveLength(MAX_LLM_ATTEMPTS);
    expect(f.payloads('assistant/attempt')).toHaveLength(MAX_LLM_ATTEMPTS);
    expect(f.types().filter((type) => type === 'assistant/attempt')).toHaveLength(MAX_LLM_ATTEMPTS);
    expect(f.types().at(-1)).toBe('turn/end');
    expect(f.payloads('turn/end')[0]).toMatchObject({
      reason: 'error',
      error: { code: 'http_error', message: 'still down', retryable: true },
    });
    expect(errorPayloads(f.live)).toEqual([{ code: 'http_error', message: 'still down', retryable: true }]);
    expect(statusStates(f.live)).toEqual(['thinking', 'idle']);
    expect(release).toHaveBeenCalledWith('s1');
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * Khung error terminate một lượt PHẢI thăng `retryable` của adapter (dòng 246 của loop.ts).
   * 503 ở test trên chứng minh `true` sống sót sau khi hết ngân sách retry nội bộ; test dưới đây
   * chốt 429 — trường hợp RateLimit mà người dùng thật sự gặp — và test `never retries a
   * non-retryable 4xx` chốt hướng NGƯỢC LẠI (`false` cũng phải sống). Bỏ `retryable:` khỏi payload
   * thì cả ba đều đỏ.
   */
  it('reaches the wire with retryable: true for an exhausted 429 rate limit', async () => {
    vi.useFakeTimers();
    const f = await fixture({ steps: [[providerError('Too many requests', 429), finishError()]] });

    const running = f.turn();
    let backoff = 0;
    for (const delay of LLM_RETRY_DELAYS_MS) backoff += delay;
    await vi.advanceTimersByTimeAsync(backoff);
    await expect(running).resolves.toMatchObject({ status: 'error' });

    expect(f.adapter.requests).toHaveLength(MAX_LLM_ATTEMPTS);
    expect(errorPayloads(f.live)).toEqual([{ code: 'http_error', message: 'Too many requests', retryable: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries a non-retryable 4xx', async () => {
    const f = await fixture({ steps: [[providerError('bad request', 400), finishError()]] });

    await expect(f.turn()).resolves.toMatchObject({ status: 'error' });

    expect(f.adapter.requests).toHaveLength(1);
    expect(f.payloads('assistant/attempt')).toHaveLength(1);
    expect(errorPayloads(f.live)).toEqual([{ code: 'http_error', message: 'bad request', retryable: false }]);
    expect(f.payloads('turn/end')[0].reason).toBe('error');
  });
});

describe('AgentLoop cancellation', () => {
  it('stops mid-stream, records the partial attempt and never calls the provider again', async () => {
    const controller = new AbortController();
    const f = await fixture({ steps: [[text('par'), waitAbort()]] });
    const release = vi.spyOn(f.pipeline, 'releaseSession');

    const running = f.turn({}, controller.signal);
    await flush();
    expect(assistantDeltas(f.live)).toEqual(['par']);
    controller.abort();

    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.types()).toEqual(['turn/start', 'user/message', 'step/start', 'assistant/attempt', 'turn/end']);
    expect(f.payloads('assistant/attempt')[0]).toEqual({
      attemptId: expect.any(String),
      error: 'The provider stream was cancelled.',
      retryable: false,
      finishedAt: expect.any(Number),
    });
    expect(f.payloads('turn/end')[0].reason).toBe('cancelled');
    expect(statusStates(f.live)).toEqual(['thinking', 'cancelled', 'idle']);
    expect(f.adapter.requests).toHaveLength(1);
    expect(release).toHaveBeenCalledWith('s1');
  });

  it('stops mid-tool, settles the call cancelled and still runs a second turn', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const held = deferred();
    const controller = new AbortController();
    const f = await fixture({
      steps: [callsStep({ id: 'c1', name: 'hang' })],
      tools: [
        tool(
          'hang',
          async () => {
            log.push('hang:start');
            await held.promise;
            log.push('hang:end');
            return 'late';
          },
          { isConcurrencySafe: false },
        ),
        tool(
          'write',
          async () => {
            log.push('write:start');
            return 'written';
          },
          { isConcurrencySafe: false },
        ),
      ],
    });

    const running = f.turn({}, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['hang:start']);

    controller.abort();
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.types().at(-2)).toBe('tool/result');
    expect(f.types().at(-1)).toBe('turn/end');
    expect(f.payloads('tool/result')[0]).toMatchObject({ callId: 'c1', status: 'cancelled', result: { error: 'CANCELLED' } });
    expect(f.payloads('turn/end')[0].reason).toBe('cancelled');
    expect(statusStates(f.live)).toEqual(['thinking', 'tool', 'cancelled', 'idle']);
    expect(log).not.toContain('hang:end');

    f.adapter.queue([callsStep({ id: 'c2', name: 'write' }), [text('second turn done'), stop()]]);
    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });
    expect(log).toEqual(['hang:start', 'write:start']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the turn with TURN_TIMEOUT when the stream never settles', async () => {
    vi.useFakeTimers();
    const f = await fixture({ steps: [[text('partial'), waitAbort()]] });
    const release = vi.spyOn(f.pipeline, 'releaseSession');

    const running = f.turn();
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);

    await expect(running).resolves.toMatchObject({ status: 'error' });
    expect(TURN_TIMEOUT_MS).toBe(600_000);
    expect(errorPayloads(f.live)).toEqual([{ code: 'TURN_TIMEOUT', message: expect.any(String), retryable: false }]);
    expect(f.types()).toEqual(['turn/start', 'user/message', 'step/start', 'assistant/attempt', 'turn/end']);
    expect(f.payloads('turn/end')[0].reason).toBe('error');
    // A timeout is an `error` turn, not a user cancel: no `cancelled` frame.
    expect(statusStates(f.live)).toEqual(['thinking', 'idle']);
    expect(f.adapter.requests).toHaveLength(1);
    expect(release).toHaveBeenCalledWith('s1');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AgentLoop inbox', () => {
  it('drains queued messages at a step boundary as steer user messages', async () => {
    const inbox = new Inbox();
    const f = await fixture({
      steps: [callsStep({ id: 'c1', name: 'queue_steer' }), [text('understood'), stop()]],
      tools: [
        tool('queue_steer', async () => {
          inbox.push('s1', 'steer from the tool');
          return 'ok';
        }),
      ],
      inbox,
    });
    inbox.push('s1', 'pre-queued');

    await expect(f.turn()).resolves.toMatchObject({ status: 'completed' });

    expect(inbox.size('s1')).toBe(0);
    expect(f.payloads('user/message')).toEqual([
      { messageId: expect.any(String), content: 'hello', source: 'user' },
      { messageId: expect.any(String), content: 'pre-queued', source: 'steer' },
      { messageId: expect.any(String), content: 'steer from the tool', source: 'steer' },
    ]);
    expect(f.types()).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'user/message',
      'user/message',
      'step/start',
      'assistant/message',
      'turn/end',
    ]);
    const first = f.adapter.requests[0].messages;
    expect(first.filter((message) => message.role === 'user')).toEqual([{ role: 'user', content: 'hello' }]);
    const second = f.adapter.requests[1].messages;
    expect(second.slice(-2)).toEqual([
      { role: 'user', content: 'pre-queued' },
      { role: 'user', content: 'steer from the tool' },
    ]);
  });

  it('does not drain the inbox at the first step', async () => {
    const inbox = new Inbox();
    const f = await fixture({ steps: [[text('hi'), stop()]], inbox });
    inbox.push('s1', 'queued while idle');

    await f.turn();

    expect(inbox.size('s1')).toBe(1);
    expect(f.payloads('user/message')).toHaveLength(1);
    expect(f.adapter.requests[0].messages.some((message) => message.content === 'queued while idle')).toBe(false);
  });
});

describe('AgentLoop context window guard', () => {
  it('trims the request and reports CONTEXT_TRIMMED when nothing is compactable', async () => {
    const f = await fixture({ steps: [[text('trimmed answer'), stop()]], context: 1_000 });
    f.events.append('s1', [
      { type: 'turn/start', payload: { turnId: 'turn_old', modelSelection: 'test-model', trigger: 'user' } },
      { type: 'user/message', payload: { messageId: 'msg_old', content: 'x'.repeat(9_000), source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'msg_old_a', content: 'old answer', finishReason: 'stop', callIds: [] } },
    ]);

    await expect(f.turn({ content: 'the newest question' })).resolves.toMatchObject({ status: 'completed' });

    expect(f.types().filter((type) => type === 'compaction/summary')).toEqual([]);
    const messages = f.adapter.requests[0].messages;
    expect(messages[0].role).toBe('system');
    expect(messages.some((message) => message.content.includes('x'.repeat(200)))).toBe(false);
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'the newest question' });
    expect(errorPayloads(f.live)).toEqual([{ code: 'CONTEXT_TRIMMED', message: expect.any(String), retryable: false }]);
    expect(f.adapter.requests).toHaveLength(1);
  });

  it('ends the turn with CONTEXT_OVERFLOW when the newest message alone cannot fit', async () => {
    const f = await fixture({ steps: [[text('never'), stop()]], context: 1_000 });

    await expect(f.turn({ content: 'y'.repeat(20_000) })).resolves.toMatchObject({ status: 'error' });

    expect(f.adapter.requests).toHaveLength(0);
    expect(errorPayloads(f.live)).toEqual([{ code: 'CONTEXT_OVERFLOW', message: expect.any(String), retryable: false }]);
    expect(f.types()).toEqual(['turn/start', 'user/message', 'step/start', 'turn/end']);
    expect(f.payloads('turn/end')[0].reason).toBe('error');
    expect(statusStates(f.live)).toEqual(['thinking', 'idle']);
  });
});

describe('AgentLoop vision input', () => {
  const attachment = { name: 'shot.png', mime: 'image/png', size: 3, data: 'aGk=' };

  it('attaches turn images to the last user message for image-capable models', async () => {
    const f = await fixture({ model: { supportsImages: true }, steps: [[text('seen'), stop()]] });

    await expect(f.turn({ content: 'look at this', attachments: [attachment] }))
      .resolves.toMatchObject({ status: 'completed' });

    const request = f.adapter.requests.at(-1);
    const last = request?.messages.filter((message) => message.role === 'user').at(-1);
    expect(last).toMatchObject({
      content: 'look at this',
      imageParts: [{ mime: 'image/png', data: 'aGk=' }],
    });
  });

  it('drops image attachments for text-only models (text still goes through)', async () => {
    const f = await fixture({ model: { supportsImages: false }, steps: [[text('hi'), stop()]] });

    await expect(f.turn({ content: 'look at this', attachments: [attachment] }))
      .resolves.toMatchObject({ status: 'completed' });

    const request = f.adapter.requests.at(-1);
    const last = request?.messages.filter((message) => message.role === 'user').at(-1);
    expect(last?.content).toBe('look at this');
    expect(last?.imageParts).toBeUndefined();
  });

  it('passes non-image attachments through without image parts', async () => {
    const f = await fixture({ model: { supportsImages: true }, steps: [[text('hi'), stop()]] });

    await expect(
      f.turn({ content: 'read this', attachments: [{ name: 'doc.txt', mime: 'text/plain', size: 3, data: 'aGk=' }] }),
    ).resolves.toMatchObject({ status: 'completed' });

    const last = f.adapter.requests.at(-1)?.messages.filter((message) => message.role === 'user').at(-1);
    expect(last?.imageParts).toBeUndefined();
  });
});
