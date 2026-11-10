import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { LiveEvent } from '../shared/types';
import type { LlmToolCall } from '../llm/types';
import type { Emit, EventPayloadMap, NewSessionEvent, SessionEvent } from '../events/types';
import { createTestDb } from '../../../test/db';
import { createEmit } from '../events/emit';
import { EventStore } from '../events/store';
import { CheckpointStore } from '../checkpoints/store';
import { ApprovalService } from './approval';
import { ToolRegistry } from './registry';
import { ToolPipeline, DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_OUTPUT_CHARS, TOOL_CONCURRENCY_LIMIT } from './pipeline';
import type { ToolContext, ToolDefinition, ToolRunContext } from './types';

function fakeEmit() {
  const durable: NewSessionEvent[] = [];
  const live: LiveEvent[] = [];
  const emit: Emit = {
    durable: (event) => {
      durable.push(event);
    },
    live: (event) => {
      live.push(event);
    },
  };
  return { emit, durable, live };
}

function def(
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

function pathTool(execute: (args: unknown, ctx: ToolContext) => Promise<unknown>, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return def(
    'read_path',
    execute,
    {
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      ...overrides,
    },
  );
}

const NO_MCP: ToolRunContext['mcp'] = {
  connected: false,
  studioLinked: false,
  server: { source: 'none', path: null, version: null },
  listTools: async () => [],
  callTool: async () => null,
  reconnect: async () => undefined,
};

function runContext(emit: Emit, signal: AbortSignal = new AbortController().signal, sessionId = 's1'): ToolRunContext {
  return { sessionId, turnId: 't1', stepId: 'st1', signal, emit, mcp: NO_MCP };
}

function call(id: string, name: string, args: unknown = {}): LlmToolCall {
  return { id, name, args };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

function durableResults(emit: ReturnType<typeof fakeEmit>): EventPayloadMap['tool/result'][] {
  return emit.durable
    .filter((event) => event.type === 'tool/result')
    .map((event) => event.payload as EventPayloadMap['tool/result']);
}

function approvalIdOf(event: NewSessionEvent | undefined): string {
  return ((event?.payload ?? {}) as EventPayloadMap['approval/request']).approvalId ?? '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolPipeline dispatch', () => {
  it('records tool/call for every call first, then tool/result per call', async () => {
    const registry = new ToolRegistry([
      def('alpha', async () => ({ value: 'a' })),
      def('beta', async () => ({ value: 'b' })),
    ]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'alpha'), call('c2', 'beta')],
      runContext(emit.emit),
    );

    expect(emit.durable.map((event) => event.type)).toEqual(['tool/call', 'tool/call', 'tool/result', 'tool/result']);
    expect(emit.durable[0].payload).toEqual({
      callId: 'c1',
      name: 'alpha',
      args: {},
      startedAt: expect.any(Number),
      // Task 31C: the card renders what the registry measured, not a name it invents.
      label: 'alpha',
      risk: 'low',
    });
    expect(emit.durable[2].payload).toEqual({
      callId: 'c1',
      status: 'done',
      result: { value: 'a' },
      durationMs: expect.any(Number),
    });
    expect(results).toEqual([
      { callId: 'c1', name: 'alpha', status: 'done', result: { value: 'a' } },
      { callId: 'c2', name: 'beta', status: 'done', result: { value: 'b' } },
    ]);
  });

  it('records one workspace checkpoint per mutating Studio tool, never for read-only tools', async () => {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'P', 1, 1);
    db.prepare('INSERT INTO sessions (id, project_id, created_at, last_updated) VALUES (?, ?, ?, ?)').run('s1', 'p1', 1, 1);
    const checkpoints = new CheckpointStore(db);
    const registry = new ToolRegistry([
      def('studio.multi_edit', async () => ({ ok: true }), {
        isConcurrencySafe: false,
        presentation: { label: 'Sửa nhiều đoạn script', risk: 'medium' },
      }),
      def('studio.script_read', async () => 'source'),
    ]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService(), undefined, undefined, checkpoints).run(
      [call('c1', 'studio.multi_edit', { path: 'ServerScriptService/Main' }), call('c2', 'studio.script_read', {})],
      runContext(emit.emit),
    );

    expect(results.map((entry) => entry.status)).toEqual(['done', 'done']);
    const rows = checkpoints.list('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0].manifest).toMatchObject({
      tool: 'studio.multi_edit',
      callId: 'c1',
      targets: ['ServerScriptService/Main'],
      outcome: 'ok',
      restorable: false,
    });
    expect(rows[0].manifest.restoreReason).toContain('không có inverse');
    db.close();
  });

  it('returns results in call order even when tools finish out of order', async () => {
    const registry = new ToolRegistry([
      def('slow', async () => {
        await delay(20);
        return 'slow';
      }),
      def('fast', async () => 'fast'),
    ]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'slow'), call('c2', 'fast')],
      runContext(emit.emit),
    );

    expect(results.map((entry) => entry.result)).toEqual(['slow', 'fast']);
    expect(durableResults(emit).map((payload) => payload.callId)).toEqual(['c2', 'c1']);
  });

  it('passes a per-call tool context built from the run context', async () => {
    let seen: ToolContext | undefined;
    const registry = new ToolRegistry([
      def('capture', async (args, ctx) => {
        seen = ctx;
        return 'ok';
      }),
    ]);
    const emit = fakeEmit();
    const controller = new AbortController();

    await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c7', 'capture', { q: 1 })],
      runContext(emit.emit, controller.signal),
    );

    expect(seen).toMatchObject({ sessionId: 's1', turnId: 't1', stepId: 'st1', callId: 'c7' });
    expect(seen?.signal).toBe(controller.signal);
    expect(seen?.emit).toBe(emit.emit);
    expect(seen?.mcp).toBe(NO_MCP);
  });

  it('records nothing and returns an empty list for no calls', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([def('alpha', execute)]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    await expect(pipeline.run([], runContext(emit.emit))).resolves.toEqual([]);

    expect(emit.durable).toEqual([]);
    expect(emit.live).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('measures every call from its own dispatch slot even when a provider repeats a call id', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry([def('first', async () => 'first'), def('second', async () => 'second')]);
    const emit = fakeEmit();
    const append = emit.emit.durable.bind(emit.emit);
    let shifted = false;
    emit.emit.durable = (event) => {
      append(event);
      if (event.type === 'tool/call' && !shifted) {
        // Move the clock between the two dispatch stamps: a start time keyed only by the
        // provider-supplied id would let the second call overwrite the first one's.
        shifted = true;
        vi.setSystemTime(Date.now() + 250);
      }
    };

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('dup', 'first'), call('dup', 'second')],
      runContext(emit.emit),
    );

    expect(results.map((entry) => entry.result)).toEqual(['first', 'second']);
    expect(durableResults(emit).map((payload) => payload.callId)).toEqual(['dup', 'dup']);
    expect(durableResults(emit).map((payload) => payload.durationMs)).toEqual([250, 0]);
  });
});

describe('ToolPipeline argument validation', () => {
  it('rejects the truncated-tool-call shape of empty args for a required property', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([pathTool(execute)]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'read_path', {})],
      runContext(emit.emit),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].name).toBe('read_path');
    expect(durableResults(emit)).toHaveLength(1);
    expect(durableResults(emit)[0].callId).toBe('c1');
    expect(durableResults(emit)[0].status).toBe('error');
    expect(durableResults(emit)[0].result).toMatchObject({ error: 'INVALID_ARGS' });
    expect((results[0].result as { message: string }).message).toContain("required property 'path'");
  });

  it('rejects wrong types, non-object args and unknown tools without throwing', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([pathTool(execute)]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'read_path', { path: 42 }), call('c2', 'read_path', 'nope'), call('c3', 'gone_tool')],
      runContext(emit.emit),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(results.map((entry) => entry.status)).toEqual(['error', 'error', 'error']);
    expect(results.map((entry) => (entry.result as { error: string }).error)).toEqual([
      'INVALID_ARGS',
      'INVALID_ARGS',
      'UNKNOWN_TOOL',
    ]);
    expect(durableResults(emit).map((payload) => payload.status)).toEqual(['error', 'error', 'error']);
  });

  it('does not ask for approval when the args are already invalid', async () => {
    const registry = new ToolRegistry([pathTool(async () => 'ran', { approval: 'ask', presentation: { label: 'Read', risk: 'high' } })]);
    const emit = fakeEmit();

    await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'read_path', {})], runContext(emit.emit));

    expect(emit.durable.map((event) => event.type)).toEqual(['tool/call', 'tool/result']);
  });

  it('reports a broken tool schema as an unavailable tool, warning once per name', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([
      def('weird', execute, { parameters: { type: 'not_a_type' } as unknown as ToolDefinition['parameters'] }),
    ]);
    const emit = fakeEmit();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'weird'), call('c2', 'weird')],
      runContext(emit.emit),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(results.map((entry) => entry.status)).toEqual(['error', 'error']);
    expect(results.map((entry) => (entry.result as { error: string }).error)).toEqual(['TOOL_UNAVAILABLE', 'TOOL_UNAVAILABLE']);
    expect(durableResults(emit).map((payload) => (payload.result as { error: string }).error)).toEqual([
      'TOOL_UNAVAILABLE',
      'TOOL_UNAVAILABLE',
    ]);
    expect((results[0].result as { message: string }).message).toContain('weird');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('weird');
    warn.mockRestore();
  });

  it('runs a tool whose optional properties are simply absent', async () => {
    const registry = new ToolRegistry([
      def('maybe', async (args) => ({ got: args }), {
        parameters: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
      }),
    ]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'maybe', {})], runContext(emit.emit));

    expect(results[0]).toEqual({ callId: 'c1', name: 'maybe', status: 'done', result: { got: {} } });
  });
});

describe('ToolPipeline approval', () => {
  it('waits for the approval decision and then executes', async () => {
    const approval = new ApprovalService();
    const execute = vi.fn(async () => 'written');
    const registry = new ToolRegistry([def('edit', execute, { approval: 'ask', presentation: { label: 'Edit', risk: 'medium' } })]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(registry, approval);

    const running = pipeline.run([call('c1', 'edit', { path: 'Script' })], runContext(emit.emit));
    await delay(0);

    const request = emit.durable.find((event) => event.type === 'approval/request');
    expect(request?.payload).toEqual({
      approvalId: expect.stringMatching(/^approval_/),
      callId: 'c1',
      name: 'edit',
      args: { path: 'Script' },
      risk: 'medium',
    });
    expect(execute).not.toHaveBeenCalled();

    approval.decide(approvalIdOf(request), 'allow', 'once');
    const results = await running;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ callId: 'c1', name: 'edit', status: 'done', result: 'written' });
    expect(durableResults(emit)[0].status).toBe('done');
  });

  it('records APPROVAL_DENIED and skips execution on deny', async () => {
    const approval = new ApprovalService();
    const execute = vi.fn(async () => 'written');
    const registry = new ToolRegistry([def('edit', execute, { approval: 'ask' })]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, approval).run([call('c1', 'edit')], runContext(emit.emit));
    await delay(0);
    approval.decide(approvalIdOf(emit.durable.find((event) => event.type === 'approval/request')), 'deny', 'once');

    const results = await running;

    expect(execute).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].result).toEqual({ error: 'APPROVAL_DENIED' });
    expect(durableResults(emit)[0].result).toEqual({ error: 'APPROVAL_DENIED' });
  });

  it('treats an expired approval as a denial', async () => {
    vi.useFakeTimers();
    const approval = new ApprovalService();
    const execute = vi.fn(async () => 'written');
    const registry = new ToolRegistry([def('edit', execute, { approval: 'ask' })]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, approval).run([call('c1', 'edit')], runContext(emit.emit));
    await vi.advanceTimersByTimeAsync(120_000);
    const results = await running;

    expect(execute).not.toHaveBeenCalled();
    expect(results[0].result).toEqual({ error: 'APPROVAL_DENIED' });
    expect(emit.durable.map((event) => event.type)).toEqual([
      'tool/call',
      'approval/request',
      'approval/decision',
      'tool/result',
    ]);
    expect((emit.durable[2].payload as EventPayloadMap['approval/decision'])).toEqual({
      approvalId: expect.any(String),
      decision: 'expired',
      scope: 'once',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('auto-approved tools never create approval events', async () => {
    const registry = new ToolRegistry([def('todo_write', async () => 'ok')]);
    const emit = fakeEmit();

    await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'todo_write')], runContext(emit.emit));

    expect(emit.durable.map((event) => event.type)).toEqual(['tool/call', 'tool/result']);
    expect(emit.live).toEqual([]);
  });

  it('asks before a high risk tool even when the registry declares it auto', async () => {
    const approval = new ApprovalService();
    const execute = vi.fn(async () => 'deployed');
    const registry = new ToolRegistry([
      def('deploy', execute, { approval: 'auto', presentation: { label: 'Deploy', risk: 'high' } }),
    ]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, approval).run([call('c1', 'deploy')], runContext(emit.emit));
    await delay(0);

    expect(registry.get('deploy')?.approval).toBe('ask');
    expect(execute).not.toHaveBeenCalled();
    expect(emit.durable.map((event) => event.type)).toEqual(['tool/call', 'approval/request']);
    expect(emit.durable[1].payload).toMatchObject({ name: 'deploy', risk: 'high' });
    expect(emit.live).toEqual([{ type: 'agent/status', payload: { state: 'waiting_approval', turnId: 't1' } }]);

    approval.decide(approvalIdOf(emit.durable[1]), 'allow', 'once');
    await expect(running).resolves.toEqual([{ callId: 'c1', name: 'deploy', status: 'done', result: 'deployed' }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not run a high risk auto tool that was denied', async () => {
    const approval = new ApprovalService();
    const execute = vi.fn(async () => 'deployed');
    const registry = new ToolRegistry([
      def('deploy', execute, { approval: 'auto', presentation: { label: 'Deploy', risk: 'high' } }),
    ]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, approval).run([call('c1', 'deploy')], runContext(emit.emit));
    await delay(0);
    approval.decide(approvalIdOf(emit.durable[1]), 'deny', 'session');

    const results = await running;
    expect(execute).not.toHaveBeenCalled();
    expect(results[0].result).toEqual({ error: 'APPROVAL_DENIED' });
  });
});

describe('ToolPipeline concurrency', () => {
  it('caps concurrency-safe tools at four running at a time', async () => {
    let active = 0;
    let peak = 0;
    const registry = new ToolRegistry([
      def('pool', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(10);
        active -= 1;
        return 'ok';
      }),
    ]);

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      Array.from({ length: 6 }, (_unused, index) => call(`c${index}`, 'pool')),
      runContext(fakeEmit().emit),
    );

    expect(TOOL_CONCURRENCY_LIMIT).toBe(4);
    expect(peak).toBe(4);
    expect(results).toHaveLength(6);
    expect(results.every((entry) => entry.status === 'done')).toBe(true);
  });

  it('holds a queued unsafe call behind exactly four running concurrency-safe calls', async () => {
    const log: string[] = [];
    const held = deferred();
    const registry = new ToolRegistry([
      def('safe', async () => {
        log.push('safe:start');
        await held.promise;
        log.push('safe:end');
        return 'safe';
      }),
      def('unsafe', async () => {
        log.push('unsafe:start');
        return 'unsafe';
      }, { isConcurrencySafe: false }),
    ]);

    const running = new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'safe'), call('c2', 'safe'), call('c3', 'safe'), call('c4', 'safe'), call('c5', 'unsafe')],
      runContext(fakeEmit().emit),
    );
    await delay(0);

    expect(log).toEqual(['safe:start', 'safe:start', 'safe:start', 'safe:start']);

    held.resolve();
    const results = await running;

    expect(log).toEqual([
      'safe:start',
      'safe:start',
      'safe:start',
      'safe:start',
      'safe:end',
      'safe:end',
      'safe:end',
      'safe:end',
      'unsafe:start',
    ]);
    expect(results.map((entry) => entry.callId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(results.every((entry) => entry.status === 'done')).toBe(true);
  });

  it('holds an unsafe tool until every running safe tool finished and blocks the queue behind it', async () => {
    const log: string[] = [];
    const track = (name: string, ms: number, isConcurrencySafe: boolean): ToolDefinition =>
      def(name, async () => {
        log.push(`${name}:start`);
        await delay(ms);
        log.push(`${name}:end`);
        return name;
      }, { isConcurrencySafe });

    const registry = new ToolRegistry([
      track('safe_a', 20, true),
      track('unsafe_b', 5, false),
      track('safe_c', 5, true),
    ]);

    await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'safe_a'), call('c2', 'unsafe_b'), call('c3', 'safe_c')],
      runContext(fakeEmit().emit),
    );

    expect(log).toEqual(['safe_a:start', 'safe_a:end', 'unsafe_b:start', 'unsafe_b:end', 'safe_c:start', 'safe_c:end']);
  });

  it('runs unsafe tools serially among themselves', async () => {
    const log: string[] = [];
    const unsafe = (name: string): ToolDefinition =>
      def(name, async () => {
        log.push(`${name}:start`);
        await delay(10);
        log.push(`${name}:end`);
        return name;
      }, { isConcurrencySafe: false });

    const registry = new ToolRegistry([unsafe('u1'), unsafe('u2')]);

    await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'u1'), call('c2', 'u2')],
      runContext(fakeEmit().emit),
    );

    expect(log).toEqual(['u1:start', 'u1:end', 'u2:start', 'u2:end']);
  });

  it('runs concurrency-safe tools in parallel', async () => {
    const log: string[] = [];
    const safe = (name: string): ToolDefinition =>
      def(name, async () => {
        log.push(`${name}:start`);
        await delay(15);
        log.push(`${name}:end`);
        return name;
      });

    const registry = new ToolRegistry([safe('s1'), safe('s2')]);

    await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 's1'), call('c2', 's2')],
      runContext(fakeEmit().emit),
    );

    expect(log).toEqual(['s1:start', 's2:start', 's1:end', 's2:end']);
  });
});

describe('ToolPipeline session exclusivity', () => {
  const hung = (name: string, log: string[], held: { promise: Promise<void> }, timeoutMs: number): ToolDefinition =>
    def(
      name,
      async () => {
        log.push(`${name}:start`);
        await held.promise;
        log.push(`${name}:end`);
        return `${name}-late`;
      },
      { isConcurrencySafe: false, timeoutMs },
    );

  it('keeps a timed-out tool holding its session slot until its own invocation settles', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const held = deferred();
    const registry = new ToolRegistry([
      hung('multi_edit', log, held, 1_000),
      def('script_write', async () => {
        log.push('script_write:start');
        return 'written';
      }, { isConcurrencySafe: false }),
    ]);
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const running = pipeline.run([call('c1', 'multi_edit')], runContext(fakeEmit().emit));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(running).resolves.toMatchObject([{ status: 'cancelled', result: { error: 'TOOL_TIMEOUT' } }]);
    expect(log).toEqual(['multi_edit:start']);

    const next = pipeline.run([call('c2', 'script_write')], runContext(fakeEmit().emit));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).not.toContain('script_write:start');

    held.resolve();
    await next;
    expect(log).toEqual(['multi_edit:start', 'multi_edit:end', 'script_write:start']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serialises an unsafe call against the previous step of the same session', async () => {
    const log: string[] = [];
    const held = deferred();
    const registry = new ToolRegistry([
      hung('multi_edit', log, held, 60_000),
      def('script_write', async () => {
        log.push('script_write:start');
        return 'written';
      }, { isConcurrencySafe: false }),
    ]);
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const step = pipeline.run([call('c1', 'multi_edit')], runContext(fakeEmit().emit));
    await delay(0);
    const next = pipeline.run([call('c2', 'script_write')], runContext(fakeEmit().emit));
    await delay(0);
    expect(log).toEqual(['multi_edit:start']);

    held.resolve();
    await Promise.all([step, next]);
    expect(log).toEqual(['multi_edit:start', 'multi_edit:end', 'script_write:start']);
  });

  it('lets exclusive calls of two different sessions run at the same time', async () => {
    const log: string[] = [];
    const left = deferred();
    const right = deferred();
    const registry = new ToolRegistry([
      def('write_a', async () => {
        log.push('write_a:start');
        await left.promise;
        log.push('write_a:end');
        return 'a';
      }, { isConcurrencySafe: false }),
      def('write_b', async () => {
        log.push('write_b:start');
        await right.promise;
        log.push('write_b:end');
        return 'b';
      }, { isConcurrencySafe: false }),
    ]);
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const first = pipeline.run([call('c1', 'write_a')], runContext(fakeEmit().emit, undefined, 's1'));
    const second = pipeline.run([call('c2', 'write_b')], runContext(fakeEmit().emit, undefined, 's2'));
    await delay(0);

    expect(log).toEqual(['write_a:start', 'write_b:start']);

    left.resolve();
    right.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map((entry) => entry[0].status)).toEqual(['done', 'done']);
    expect(log).toEqual(['write_a:start', 'write_b:start', 'write_a:end', 'write_b:end']);
  });

  it('Stop abandons a call queued behind a hung exclusive tool', async () => {
    const log: string[] = [];
    const held = deferred();
    const registry = new ToolRegistry([
      hung('multi_edit', log, held, 60_000),
      def('script_write', async () => {
        log.push('script_write:start');
        return 'written';
      }, { isConcurrencySafe: false }),
    ]);
    const pipeline = new ToolPipeline(registry, new ApprovalService());
    const controller = new AbortController();

    const step = pipeline.run([call('c1', 'multi_edit')], runContext(fakeEmit().emit, controller.signal));
    const queued = pipeline.run([call('c2', 'script_write')], runContext(fakeEmit().emit, controller.signal));
    await delay(0);
    expect(log).toEqual(['multi_edit:start']);

    controller.abort();
    await expect(queued).resolves.toMatchObject([{ status: 'cancelled', result: { error: 'CANCELLED' } }]);
    expect(log).not.toContain('script_write:start');

    held.resolve();
    await step;
    await delay(0);
    expect(log).toEqual(['multi_edit:start', 'multi_edit:end']);
  });

  it('releaseSession hands the session to a fresh gate when the turn ends', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const held = deferred();
    const registry = new ToolRegistry([
      hung('multi_edit', log, held, 1_000),
      def('script_write', async () => {
        log.push('script_write:start');
        return 'written';
      }, { isConcurrencySafe: false }),
    ]);
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const running = pipeline.run([call('c1', 'multi_edit')], runContext(fakeEmit().emit));
    await vi.advanceTimersByTimeAsync(1_000);
    await running;

    pipeline.releaseSession('s1');
    await expect(pipeline.run([call('c2', 'script_write')], runContext(fakeEmit().emit))).resolves.toMatchObject([
      { status: 'done', result: 'written' },
    ]);
    expect(log).toEqual(['multi_edit:start', 'script_write:start']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ToolPipeline timeout and abort', () => {
  it('defaults tool timeouts to 60 seconds', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(60_000);
  });

  it('cancels a tool that exceeds its timeout and ignores its late result', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry([
      def('stall', async () => {
        await delay(10_000);
        return 'late';
      }, { timeoutMs: 1_000 }),
    ]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'stall')], runContext(emit.emit));
    await vi.advanceTimersByTimeAsync(1_000);
    const results = await running;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(results[0].status).toBe('cancelled');
    expect(results[0].result).toEqual({ error: 'TOOL_TIMEOUT' });
    expect(durableResults(emit)).toHaveLength(1);
    expect(durableResults(emit)[0]).toMatchObject({ callId: 'c1', status: 'cancelled', result: { error: 'TOOL_TIMEOUT' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels without executing when the turn signal is already aborted', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([def('never', execute)]);
    const emit = fakeEmit();
    const controller = new AbortController();
    controller.abort();

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'never')], runContext(emit.emit, controller.signal));

    expect(execute).not.toHaveBeenCalled();
    expect(results[0].status).toBe('cancelled');
    expect(results[0].result).toEqual({ error: 'CANCELLED' });
  });

  it('cancels a running tool when the signal aborts mid-flight', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const registry = new ToolRegistry([
      def('wait_abort', async (_args, ctx) => {
        await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('finished'), 30_000);
          timer.unref?.();
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve('aborted');
          }, { once: true });
        });
        return 'never seen';
      }),
    ]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'wait_abort')], runContext(emit.emit, controller.signal));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(running).resolves.toMatchObject([{ status: 'cancelled', result: { error: 'CANCELLED' } }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prefers cancellation over a denial once the turn is aborted', async () => {
    const controller = new AbortController();
    const approval = new ApprovalService();
    const registry = new ToolRegistry([def('edit', async () => 'ran', { approval: 'ask' })]);
    const emit = fakeEmit();

    const running = new ToolPipeline(registry, approval).run([call('c1', 'edit')], runContext(emit.emit, controller.signal));
    await delay(0);
    controller.abort();

    const results = await running;

    expect(results[0].status).toBe('cancelled');
    expect(results[0].result).toEqual({ error: 'CANCELLED' });
  });

  it('reports a throwing tool as an error result', async () => {
    const registry = new ToolRegistry([
      def('boom', async () => {
        throw new Error('disk on fire');
      }),
    ]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'boom')], runContext(emit.emit));

    expect(results[0].status).toBe('error');
    expect(results[0].result).toEqual({ error: 'TOOL_FAILED', message: 'disk on fire' });
  });

  it('reports a synchronously throwing tool as an error result', async () => {
    const registry = new ToolRegistry([
      def('boom', (() => {
        throw new Error('sync boom');
      }) as ToolDefinition['execute']),
    ]);

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'boom')], runContext(fakeEmit().emit));

    expect(results[0].result).toEqual({ error: 'TOOL_FAILED', message: 'sync boom' });
  });
});

describe('ToolPipeline output cap', () => {
  it('caps a long string result at 50,000 characters', async () => {
    const registry = new ToolRegistry([def('long', async () => 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 10_000))]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'long')], runContext(emit.emit));

    expect(MAX_TOOL_OUTPUT_CHARS).toBe(50_000);
    expect(results[0].status).toBe('done');
    expect(typeof results[0].result).toBe('string');
    const capped = results[0].result as string;
    // Task 31B Step 6: keep the 50k body, then append a marker with the real size + how to page.
    expect(capped.slice(0, MAX_TOOL_OUTPUT_CHARS)).toBe('x'.repeat(MAX_TOOL_OUTPUT_CHARS));
    expect(capped.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS);
    expect(capped).toContain('đã cắt bớt');
    expect(capped).toContain(String(MAX_TOOL_OUTPUT_CHARS + 10_000));
    expect(durableResults(emit)[0].result).toBe(results[0].result);
  });

  it('stores the truncated serialized text when an object result is too large', async () => {
    const registry = new ToolRegistry([def('blob', async () => ({ data: 'y'.repeat(60_000) }))]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'blob')], runContext(emit.emit));

    expect(typeof results[0].result).toBe('string');
    const capped = results[0].result as string;
    expect(capped.slice(0, MAX_TOOL_OUTPUT_CHARS)).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
    expect(capped.startsWith('{"data":"yyy')).toBe(true);
    expect(capped).toContain('đã cắt bớt');
    expect(results[0].status).toBe('done');
  });

  it('keeps small object results as objects and adds no truncated marker', async () => {
    const registry = new ToolRegistry([def('small', async () => ({ ok: true }))]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'small')], runContext(emit.emit));

    expect(results[0].result).toEqual({ ok: true });
    expect(emit.durable[1].payload).toEqual({
      callId: 'c1',
      status: 'done',
      result: { ok: true },
      durationMs: expect.any(Number),
    });
  });

  it('caps results that cannot be serialized as JSON', async () => {
    const registry = new ToolRegistry([
      def('circular', async () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      }),
    ]);

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'circular')], runContext(fakeEmit().emit));

    expect(results[0].status).toBe('done');
    expect(typeof results[0].result).toBe('string');
    expect((results[0].result as string).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });

  it('lets an undefined result through untouched', async () => {
    const registry = new ToolRegistry([def('nothing', async () => undefined)]);

    const results = await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'nothing')], runContext(fakeEmit().emit));

    expect(results[0].status).toBe('done');
    expect(results[0].result).toBeUndefined();
  });

  it('spills oversized text to a file and returns a head/tail preview with a locator', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SpillStore } = await import('../spill/store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-spill-pipeline-'));
    const spill = new SpillStore(dir);
    const big = `START${'x'.repeat(60_000)}END`;
    const registry = new ToolRegistry([def('big', async () => big)]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService(), undefined, spill).run(
      [call('c1', 'big')],
      runContext(emit.emit),
    );

    expect(results[0].status).toBe('done');
    const preview = results[0].result as string;
    expect(preview.startsWith('START')).toBe(true);
    expect(preview).toContain('Full formatted result stored at:');
    expect(preview).toContain('read_spill');
    // The full text is retrievable from the locator, both ends preserved.
    const locatorMatch = /stored at: (\S+)\./.exec(preview);
    expect(locatorMatch).not.toBeNull();
    const full = spill.readSlice(locatorMatch![1], 0, 200_000);
    expect(full.text).toBe(big);
    // Durable event carries the preview, not the full body.
    expect(durableResults(emit)[0].result).toBe(preview);
  });

  it('falls back to truncation when the spill store throws', async () => {
    const { SpillStore } = await import('../spill/store');
    const broken = new SpillStore();
    broken.saveText = () => { throw new Error('disk full'); };
    const registry = new ToolRegistry([def('big', async () => 'y'.repeat(60_000))]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService(), undefined, broken).run(
      [call('c1', 'big')],
      runContext(emit.emit),
    );

    expect(results[0].status).toBe('done');
    expect(results[0].result as string).toContain('đã cắt bớt');
  });
});

describe('ToolPipeline durable events', () => {
  function openStore(): { db: Database.Database; store: EventStore } {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'Project', 1, 1);
    db.prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)').run('s1', 'p1', 'Session', 1, 1);
    return { db, store: new EventStore(db) };
  }

  it('writes call, request, decision and result rows and streams them to the live sink', async () => {
    const { db, store } = openStore();
    try {
      const live: (SessionEvent | LiveEvent)[] = [];
      const emit = createEmit(store, 's1', (event) => live.push(event));
      const approval = new ApprovalService();
      const registry = new ToolRegistry([def('edit', async () => 'written', { approval: 'ask' })]);

      const running = new ToolPipeline(registry, approval).run([call('c1', 'edit', { path: 'Script' })], runContext(emit));
      const request = store.list('s1').find((row) => row.type === 'approval/request');
      expect(request).toBeDefined();

      approval.decide((request?.payload as EventPayloadMap['approval/request']).approvalId, 'allow', 'once');
      const results = await running;

      expect(store.list('s1').map((row) => row.type)).toEqual([
        'tool/call',
        'approval/request',
        'approval/decision',
        'tool/result',
      ]);
      expect(store.list('s1').map((row) => row.seq)).toEqual([1, 2, 3, 4]);
      const result = store.list('s1')[3].payload as EventPayloadMap['tool/result'];
      expect(result).toMatchObject({ callId: 'c1', status: 'done', result: 'written' });
      expect(live.filter((event) => 'seq' in event)).toHaveLength(4);
      expect(live.filter((event) => 'payload' in event && !('seq' in event))).toEqual([
        { type: 'agent/status', payload: { state: 'waiting_approval', turnId: 't1' } },
      ]);
      expect(results[0].status).toBe('done');
    } finally {
      db.close();
    }
  });

  it('persists the capped output in the event row', async () => {
    const { db, store } = openStore();
    try {
      const emit = createEmit(store, 's1');
      const registry = new ToolRegistry([def('long', async () => 'z'.repeat(MAX_TOOL_OUTPUT_CHARS + 1))]);

      await new ToolPipeline(registry, new ApprovalService()).run([call('c1', 'long')], runContext(emit));

      const result = store.list('s1')[1].payload as EventPayloadMap['tool/result'];
      expect(typeof result.result).toBe('string');
      const capped = result.result as string;
      expect(capped.slice(0, MAX_TOOL_OUTPUT_CHARS)).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
      expect(capped).toContain('đã cắt bớt');
    } finally {
      db.close();
    }
  });
});

describe('ToolPipeline tool/call payload (Task 31C)', () => {
  it('carries the measured label and risk so the card never guesses them', async () => {
    const registry = new ToolRegistry([def('studio.get_studio_state', async () => 'ok', {
      presentation: { label: 'Đọc trạng thái Studio', risk: 'low' },
    })]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    await pipeline.run([call('c1', 'studio.get_studio_state')], runContext(emit.emit));

    const payload = emit.durable.find((event) => event.type === 'tool/call')?.payload as { label?: string; risk?: string };
    expect(payload.label).toBe('Đọc trạng thái Studio');
    expect(payload.risk).toBe('low');
  });
});

describe('ToolPipeline output budget (Task 31C follow-up)', () => {
  it('trims to the turn budget derived from the model window, not the flat ceiling', async () => {
    const registry = new ToolRegistry([def('chatty', async () => 'x'.repeat(5_000))]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const results = await pipeline.run([call('c1', 'chatty')], {
      ...runContext(emit.emit),
      outputBudgetChars: 1_000,
    });

    const text = results[0].result as string;
    expect(text.startsWith('x'.repeat(1_000))).toBe(true);
    expect(text.length).toBeLessThan(1_300);
    expect(text).toContain('giữ 1000');
    // The durable row and the live frame must agree: one trim, one record.
    const stored = emit.durable.find((event) => event.type === 'tool/result')?.payload as { result?: string };
    expect(stored.result).toBe(text);
  });

  it('lets a single tool cap itself below the turn budget', async () => {
    const registry = new ToolRegistry([
      def('tree', async () => 'y'.repeat(9_000), { maxOutputChars: 2_000 }),
    ]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const results = await pipeline.run([call('c1', 'tree')], {
      ...runContext(emit.emit),
      outputBudgetChars: 50_000,
    });

    const text = results[0].result as string;
    expect(text.startsWith('y'.repeat(2_000))).toBe(true);
    expect(text.length).toBeLessThan(2_300);
  });

  it('keeps the flat ceiling when no budget is supplied', async () => {
    const registry = new ToolRegistry([def('plain', async () => 'z'.repeat(MAX_TOOL_OUTPUT_CHARS + 10))]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(registry, new ApprovalService());

    const results = await pipeline.run([call('c1', 'plain')], runContext(emit.emit));

    expect((results[0].result as string).startsWith('z'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
  });
});

describe('ToolPipeline per-session disable (Task 31B Step 5)', () => {
  it('refuses to execute a disabled tool and settles it as TOOL_DISABLED', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([def('studio.insert_asset', execute)]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(
      registry,
      new ApprovalService(),
      (sessionId, name) => !(sessionId === 's1' && name === 'studio.insert_asset'),
    );

    const results = await pipeline.run([call('c1', 'studio.insert_asset')], runContext(emit.emit));

    expect(execute).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].result).toEqual({ error: 'TOOL_DISABLED', message: expect.any(String) });
  });

  it('still executes an enabled tool for the same session', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry([def('studio.script_read', execute)]);
    const emit = fakeEmit();
    const pipeline = new ToolPipeline(
      registry,
      new ApprovalService(),
      (sessionId, name) => !(sessionId === 's1' && name === 'studio.insert_asset'),
    );

    const results = await pipeline.run([call('c1', 'studio.script_read')], runContext(emit.emit));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe('done');
  });
});

describe('ToolPipeline image output', () => {
  it('carries tool images on the run result without persisting the base64', async () => {
    const images = [{ mime: 'image/png', data: 'aGVsbG8=' }];
    const registry = new ToolRegistry([def('capture', async () => ({ text: '[Ảnh image/png, 5 B]', images }))]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'capture')],
      runContext(emit.emit),
    );

    expect(results[0].status).toBe('done');
    expect(results[0].images).toEqual(images);
    expect(results[0].result).toBe('[Ảnh image/png, 5 B]');
    // The durable row is what later turns re-project: pixels must never enter the event log.
    expect(durableResults(emit)[0].result).toBe('[Ảnh image/png, 5 B]');
  });

  it('leaves a structured result that merely has an images key alone when the shape is invalid', async () => {
    const value = { text: 'ok', images: [{ mime: 'image/png' }] };
    const registry = new ToolRegistry([def('odd', async () => value)]);
    const emit = fakeEmit();

    const results = await new ToolPipeline(registry, new ApprovalService()).run(
      [call('c1', 'odd')],
      runContext(emit.emit),
    );

    expect(results[0].images).toBeUndefined();
    expect(results[0].result).toEqual(value);
  });
});
