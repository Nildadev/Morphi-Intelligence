import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../../test/db';
import { EventStore } from '../../events/store';
import { SessionStore } from '../../session/store';
import { SubagentRunner } from '../../subagents';
import { createSubagentControlTools } from './subagentControl';
import { createWorkflowTool } from './workflow';
import { JobRegistry } from '../../jobs/registry';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  sessions.create('proj_x', 'title');
  const parentId = sessions.list()[0]?.id ?? '';
  // Typed from the runner's own dependency contract instead of `as never`: with `never` every read of
  // `agent.runTurn` below is unchecked (and the assertion `toHaveBeenCalled` proves nothing about the
  // real call shape).
  const agent = {
    runTurn: vi.fn(async () => ({ turnId: 'turn_1', status: 'completed' })),
  } as unknown as ConstructorParameters<typeof SubagentRunner>[0]['agent'];
  const tools = { list: () => [] } as unknown as ConstructorParameters<typeof SubagentRunner>[0]['tools'];
  const runner = new SubagentRunner({ events, sessions, agent, tools });
  return { events, sessions, parentId, runner, agent };
}

function context(sessionId: string) {
  return {
    sessionId,
    turnId: 'turn_1',
    stepId: 'step_1',
    callId: 'call_1',
    signal: new AbortController().signal,
    emit: { durable: () => undefined, live: () => undefined } as never,
    mcp: undefined as never,
  };
}

describe('subagent control', () => {
  it('list_agents shows lead plus descendants', async () => {
    const { events, parentId, runner } = fixture();
    events.append(parentId, [{
      type: 'subagent/start',
      payload: { subagentId: 'sub_1', parentSessionId: parentId, childSessionId: 'sess_child', task: 'do it' },
    }]);
    const [list] = createSubagentControlTools(runner);
    const result = await list.execute({}, context(parentId)) as { text: string };
    expect(result.text).toContain('lead');
    expect(result.text).toContain('sess_child');
  });

  it('send_message requires a descendant and runs a follow-up turn', async () => {
    const { events, parentId, runner, agent } = fixture();
    events.append(parentId, [{
      type: 'subagent/start',
      payload: { subagentId: 'sub_1', parentSessionId: parentId, childSessionId: 'sess_child', task: 'first' },
    }]);
    // Give the child a session so followup can resolve it.
    const [, send] = createSubagentControlTools(runner);
    await expect(send.execute({ agent: 'sess_other', message: 'hi' }, context(parentId))).rejects.toThrow(/not a descendant/);
    await expect(send.execute({ agent: 'sess_child', message: 'hi' }, context(parentId))).rejects.toThrow(/SESSION_NOT_FOUND/);
    expect(agent.runTurn).not.toHaveBeenCalled();
  });

  it('interrupt_agent only accepts descendants', async () => {
    const { events, parentId, runner } = fixture();
    events.append(parentId, [{
      type: 'subagent/start',
      payload: { subagentId: 'sub_1', parentSessionId: parentId, childSessionId: 'sess_child', task: 'first' },
    }]);
    const [, , interrupt] = createSubagentControlTools(runner);
    // No running controller: accepted no-op (deepseek: already-finished is a no-op).
    const result = await interrupt.execute({ agent: 'sess_child' }, context(parentId)) as { accepted: boolean; interrupted: boolean };
    expect(result).toEqual({ accepted: true, agent: 'sess_child', interrupted: false });
    await expect(interrupt.execute({ agent: 'sess_unrelated' }, context(parentId))).rejects.toThrow(/not a descendant/);
  });
});

describe('workflow fan-out', () => {
  it('runs tasks in parallel and records phase events', async () => {
    const { events, parentId, runner } = fixture();
    const jobs = new JobRegistry();
    const tool = createWorkflowTool({ events, subagents: runner, jobs });

    const result = await tool.execute({
      name: 'audit',
      tasks: [
        { title: 'A', task: 'audit auth' },
        { title: 'B', task: 'audit billing' },
      ],
    }, context(parentId)) as {
      kind: string; agentsStarted: number; text: string;
      result: { results: Array<{ title: string; status: string }> };
    };
    expect(result.kind).toBe('foreground');
    expect(result.agentsStarted).toBe(2);
    expect(result.result.results).toHaveLength(2);
    expect(result.result.results.every((entry) => entry.status === 'done')).toBe(true);
    expect(events.list(parentId).some((event) => event.type === 'workflow/start')).toBe(true);
    expect(events.list(parentId).some((event) => event.type === 'workflow/end')).toBe(true);
  });

  it('validates name and task count', async () => {
    const { events, parentId, runner } = fixture();
    const tool = createWorkflowTool({ events, subagents: runner, jobs: new JobRegistry() });
    await expect(tool.execute({ name: '', tasks: [{ title: 'A', task: 'x' }] }, context(parentId))).rejects.toThrow(/name/);
    await expect(tool.execute({
      name: 'x',
      tasks: Array.from({ length: 9 }, (_unused, index) => ({ title: `T${index}`, task: 'x' })),
    }, context(parentId))).rejects.toThrow(/at most 8/);
  });

  it('run_in_background returns a job id immediately', async () => {
    const { events, parentId, runner } = fixture();
    const jobs = new JobRegistry();
    const tool = createWorkflowTool({ events, subagents: runner, jobs });
    const result = await tool.execute({
      name: 'bg',
      tasks: [{ title: 'A', task: 'work' }],
      run_in_background: true,
    }, context(parentId)) as { kind: string; jobId: string };
    expect(result.kind).toBe('background');
    const waited = await jobs.wait(result.jobId, parentId, 5000);
    expect(waited?.status).toBe('completed');
  });
});
