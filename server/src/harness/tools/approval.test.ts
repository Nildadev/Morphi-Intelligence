import type { LiveEvent } from '../shared/types';
import type { Emit, EventPayloadMap, NewSessionEvent } from '../events/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalService, APPROVAL_TIMEOUT_MS } from './approval';
import type { ApprovalOutcome, ApprovalRequestInput } from './approval';

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

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    sessionId: 's1',
    callId: 'c1',
    name: 'edit_script',
    args: { path: 'Workspace/Script', source: 'print(1)' },
    risk: 'medium',
    approval: 'ask',
    turnId: 't1',
    ...overrides,
  };
}

function requestId(event: NewSessionEvent): string {
  return (event.payload as EventPayloadMap['approval/request']).approvalId;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalService auto policy', () => {
  it('resolves allow immediately and emits nothing', async () => {
    const service = new ApprovalService();
    const { emit, durable, live } = fakeEmit();

    const outcome = await service.request(input({ approval: 'auto', name: 'todo_write', risk: 'low' }), emit);

    expect(outcome).toEqual({ allowed: true, decision: 'allow', scope: 'once' });
    expect(durable).toEqual([]);
    expect(live).toEqual([]);
  });

  it('auto does not need a timer', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit } = fakeEmit();

    await service.request(input({ approval: 'auto' }), emit);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('never auto-approves high risk, whatever the tool declares', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable, live } = fakeEmit();

    const pending = service.request(input({ approval: 'auto', risk: 'high', name: 'run_code' }), emit);

    expect(durable).toHaveLength(1);
    expect(durable[0].type).toBe('approval/request');
    expect(durable[0].payload).toMatchObject({ name: 'run_code', risk: 'high' });
    expect(live).toEqual([{ type: 'agent/status', payload: { state: 'waiting_approval', turnId: 't1' } }]);

    service.decide(requestId(durable[0]), 'allow', 'once');
    await expect(pending).resolves.toEqual({ allowed: true, decision: 'allow', scope: 'once' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('denies an auto-declared high risk tool on expiry, not by short-circuit', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();

    const pending = service.request(input({ approval: 'auto', risk: 'high' }), emit);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ allowed: false, decision: 'expired', scope: 'once' });
    expect(durable.map((event) => event.type)).toEqual(['approval/request', 'approval/decision']);
  });
});

describe('ApprovalService ask policy', () => {
  it('records the request durably, marks the agent waiting, and stays pending until decide', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable, live } = fakeEmit();
    let outcome: ApprovalOutcome | undefined;

    const pending = service.request(input(), emit).then((resolved) => {
      outcome = resolved;
    });

    expect(durable).toHaveLength(1);
    expect(durable[0].type).toBe('approval/request');
    expect(durable[0].payload).toEqual({
      approvalId: expect.stringMatching(/^approval_/),
      callId: 'c1',
      name: 'edit_script',
      args: { path: 'Workspace/Script', source: 'print(1)' },
      risk: 'medium',
    });
    expect(live).toEqual([{ type: 'agent/status', payload: { state: 'waiting_approval', turnId: 't1' } }]);

    await Promise.resolve();
    expect(outcome).toBeUndefined();

    service.decide(requestId(durable[0]), 'allow', 'once');
    await pending;

    expect(durable[1]).toEqual({
      type: 'approval/decision',
      payload: { approvalId: requestId(durable[0]), decision: 'allow', scope: 'once' },
    });
    expect(outcome).toEqual({ allowed: true, decision: 'allow', scope: 'once' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('omits the turn id from the live status when the request has none', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable, live } = fakeEmit();
    const pending = service.request(input({ turnId: undefined }), emit);

    expect(live).toEqual([{ type: 'agent/status', payload: { state: 'waiting_approval' } }]);
    service.decide(requestId(durable[0]), 'deny', 'once');
    await pending;
  });

  it('streams the decision through the emit passed to request so the open SSE sees it', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const first = fakeEmit();
    let outcome: ApprovalOutcome | undefined;

    const pending = service.request(input(), first.emit).then((resolved) => {
      outcome = resolved;
    });
    const id = requestId(first.durable[0]);
    service.decide(id, 'deny', 'once');
    await pending;

    expect(outcome).toEqual({ allowed: false, decision: 'deny', scope: 'once' });
    expect(first.durable[1].payload).toEqual({ approvalId: id, decision: 'deny', scope: 'once' });
    expect(requestId(first.durable[0])).toBe(id);
  });

  it('suppresses a later ask call after a session allow for that tool', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input(), emit);
    service.decide(requestId(durable[0]), 'allow', 'session');
    await pending;

    const second = fakeEmit();
    const outcome = await service.request(input({ callId: 'c2' }), second.emit);

    expect(outcome).toEqual({ allowed: true, decision: 'allow', scope: 'session' });
    expect(second.durable).toEqual([]);
    expect(second.live).toEqual([]);
  });

  it('does not let a session allow cross tool names or sessions', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input(), emit);
    service.decide(requestId(durable[0]), 'allow', 'session');
    await pending;

    const otherSession = fakeEmit();
    const otherSessionPending = service.request(input({ sessionId: 's2', callId: 'c2' }), otherSession.emit);
    const otherTool = fakeEmit();
    const otherToolPending = service.request(input({ name: 'insert_model', callId: 'c3' }), otherTool.emit);

    expect(otherSession.durable).toHaveLength(1);
    expect(otherTool.durable).toHaveLength(1);
    service.decide(requestId(otherSession.durable[0]), 'deny', 'once');
    service.decide(requestId(otherTool.durable[0]), 'deny', 'once');
    await Promise.all([otherSessionPending, otherToolPending]);
  });

  it('does not remember a session-scoped deny', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input(), emit);
    service.decide(requestId(durable[0]), 'deny', 'session');
    await pending;

    const second = fakeEmit();
    const secondPending = service.request(input({ callId: 'c2' }), second.emit);

    expect(second.durable).toHaveLength(1);
    expect(second.durable[0].type).toBe('approval/request');
    service.decide(requestId(second.durable[0]), 'allow', 'once');
    await expect(secondPending).resolves.toEqual({ allowed: true, decision: 'allow', scope: 'once' });
  });

  it('resolves only the approval that was decided', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const firstCall = service.request(input({ callId: 'c1' }), emit);
    const secondCall = service.request(input({ callId: 'c2' }), emit);
    const firstId = requestId(durable[0]);
    const secondId = requestId(durable[1]);

    service.decide(firstId, 'allow', 'once');

    await expect(firstCall).resolves.toEqual({ allowed: true, decision: 'allow', scope: 'once' });
    expect(durable[2].payload).toEqual({ approvalId: firstId, decision: 'allow', scope: 'once' });
    service.decide(secondId, 'deny', 'once');
    await expect(secondCall).resolves.toEqual({ allowed: false, decision: 'deny', scope: 'once' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ApprovalService expiry', () => {
  it('resolves expired at exactly the 120 second timeout and records expired/once', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    let outcome: ApprovalOutcome | undefined;

    const pending = service.request(input(), emit).then((resolved) => {
      outcome = resolved;
    });
    const id = requestId(durable[0]);

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    expect(durable).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(APPROVAL_TIMEOUT_MS).toBe(120_000);
    expect(outcome).toEqual({ allowed: false, decision: 'expired', scope: 'once' });
    expect(durable[1]).toEqual({
      type: 'approval/decision',
      payload: { approvalId: id, decision: 'expired', scope: 'once' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a decision that arrives after the request expired', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input(), emit);
    const id = requestId(durable[0]);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await pending;

    expect(service.decide(id, 'allow', 'session')).toBe(false);
    expect(durable.filter((event) => event.type === 'approval/decision')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the timer when a decision resolves first', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input(), emit);
    service.decide(requestId(durable[0]), 'deny', 'once');
    await pending;

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS * 2);
    expect(durable).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an unknown approval id', () => {
    const service = new ApprovalService();

    expect(service.decide('approval_missing', 'allow', 'once')).toBe(false);
  });

  it('treats a second decision for the same approval as a no-op', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input(), emit);
    const id = requestId(durable[0]);

    expect(service.decide(id, 'allow', 'session')).toBe(true);
    expect(service.decide(id, 'deny', 'once')).toBe(false);
    await pending;

    expect(durable[1]).toEqual({ type: 'approval/decision', payload: { approvalId: id, decision: 'allow', scope: 'session' } });
  });

  it('expires a pending request when the turn signal aborts', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const controller = new AbortController();
    const { emit, durable, live } = fakeEmit();
    const pending = service.request(input({ signal: controller.signal }), emit);
    const id = requestId(durable[0]);

    controller.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ allowed: false, decision: 'expired', scope: 'once' });
    expect(durable[1]).toEqual({ type: 'approval/decision', payload: { approvalId: id, decision: 'expired', scope: 'once' } });
    expect(live.filter((event) => event.type === 'agent/status')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an already aborted turn before recording any request', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const controller = new AbortController();
    controller.abort();
    const { emit, durable, live } = fakeEmit();

    const outcome = await service.request(input({ signal: controller.signal }), emit);

    expect(outcome).toEqual({ allowed: false, decision: 'expired', scope: 'once' });
    expect(durable).toEqual([]);
    expect(live).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an already aborted high risk call without a phantom modal row', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const controller = new AbortController();
    controller.abort();
    const { emit, durable, live } = fakeEmit();

    const outcome = await service.request(input({ risk: 'high', approval: 'auto', signal: controller.signal }), emit);

    expect(outcome).toEqual({ allowed: false, decision: 'expired', scope: 'once' });
    expect(durable).toEqual([]);
    expect(live).toEqual([]);
  });
});

describe('ApprovalService ask-once session approvals', () => {
  it('auto-allows the second call of the same tool in the same session without a request', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input({ approval: 'ask-once', name: 'get_console_output' }), emit);
    service.decide(requestId(durable[0]), 'allow', 'session');
    await pending;

    const second = fakeEmit();
    const outcome = await service.request(input({ approval: 'ask-once', name: 'get_console_output', callId: 'c2' }), second.emit);

    expect(outcome).toEqual({ allowed: true, decision: 'allow', scope: 'session' });
    expect(second.durable).toEqual([]);
    expect(second.live).toEqual([]);
  });

  it('does not remember a once-scoped allow', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input({ approval: 'ask-once', name: 'get_console_output' }), emit);
    service.decide(requestId(durable[0]), 'allow', 'once');
    await pending;

    const second = fakeEmit();
    const secondPending = service.request(input({ approval: 'ask-once', name: 'get_console_output' }), second.emit);

    expect(second.durable).toHaveLength(1);
    expect(second.durable[0].type).toBe('approval/request');
    service.decide(requestId(second.durable[0]), 'deny', 'once');
    await secondPending;
  });

  it('scopes the remembered allow to one session and one tool', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input({ approval: 'ask-once', name: 'get_console_output' }), emit);
    service.decide(requestId(durable[0]), 'allow', 'session');
    await pending;

    const otherSession = fakeEmit();
    const otherSessionPending = service.request(input({ approval: 'ask-once', name: 'get_console_output', sessionId: 's2' }), otherSession.emit);
    const otherTool = fakeEmit();
    const otherToolPending = service.request(input({ approval: 'ask-once', name: 'list_classes' }), otherTool.emit);

    expect(otherSession.durable).toHaveLength(1);
    expect(otherTool.durable).toHaveLength(1);
    service.decide(requestId(otherSession.durable[0]), 'deny', 'once');
    service.decide(requestId(otherTool.durable[0]), 'deny', 'once');
    await Promise.all([otherSessionPending, otherToolPending]);
  });

  it('always asks for high risk tools even when the session already allowed them', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input({ approval: 'ask-once', name: 'run_code', risk: 'high' }), emit);
    service.decide(requestId(durable[0]), 'allow', 'session');
    await pending;

    const second = fakeEmit();
    const secondPending = service.request(input({ approval: 'ask-once', name: 'run_code', risk: 'high', callId: 'c2' }), second.emit);

    expect(second.durable).toHaveLength(1);
    expect(second.durable[0].type).toBe('approval/request');
    expect(second.live).toEqual([{ type: 'agent/status', payload: { state: 'waiting_approval', turnId: 't1' } }]);

    service.decide(requestId(second.durable[0]), 'allow', 'session');
    await expect(secondPending).resolves.toEqual({ allowed: true, decision: 'allow', scope: 'session' });
  });

  it('keeps asking for a high risk ask tool after its session allow', async () => {
    vi.useFakeTimers();
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();
    const pending = service.request(input({ name: 'multi_edit', risk: 'high' }), emit);
    service.decide(requestId(durable[0]), 'allow', 'session');
    await pending;

    const second = fakeEmit();
    const secondPending = service.request(input({ name: 'multi_edit', risk: 'high', callId: 'c2' }), second.emit);

    expect(second.durable).toHaveLength(1);
    expect(second.durable[0].type).toBe('approval/request');
    service.decide(requestId(second.durable[0]), 'deny', 'once');
    await expect(secondPending).resolves.toEqual({ allowed: false, decision: 'deny', scope: 'once' });
  });
});

describe('ApprovalService permission mode', () => {
  it('full access bypasses the gate for every tool, including high risk', async () => {
    const service = new ApprovalService();
    const { emit, durable, live } = fakeEmit();

    const outcome = await service.request(input({ approval: 'auto', risk: 'high', name: 'run_code' }), emit, 'full');

    expect(outcome).toEqual({ allowed: true, decision: 'allow', scope: 'once' });
    expect(durable).toEqual([]);
    expect(live).toEqual([]);
  });

  it('ask mode forces an auto tool to prompt instead of short-circuiting', async () => {
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();

    const pending = service.request(input({ approval: 'auto', risk: 'low', name: 'todo_write' }), emit, 'ask');

    expect(durable).toHaveLength(1);
    expect(durable[0].type).toBe('approval/request');
    service.decide(requestId(durable[0]), 'allow', 'once');
    await expect(pending).resolves.toEqual({ allowed: true, decision: 'allow', scope: 'once' });
  });

  it('balanced (the default) keeps the historical auto policy when no mode is passed', async () => {
    const service = new ApprovalService();
    const { emit, durable } = fakeEmit();

    const outcome = await service.request(input({ approval: 'auto', risk: 'low', name: 'todo_write' }), emit);

    expect(outcome).toEqual({ allowed: true, decision: 'allow', scope: 'once' });
    expect(durable).toEqual([]);
  });
});
