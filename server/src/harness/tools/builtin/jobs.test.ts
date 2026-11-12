import { describe, expect, it, vi } from 'vitest';
import { JobRegistry } from '../../jobs/registry';
import { createJobTools } from './jobs';

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

describe('job tools', () => {
  it('job_start returns an id immediately and job_output collects the result', async () => {
    const jobs = new JobRegistry();
    const subagents = {
      run: vi.fn(async (_parentId: string, task: string) => ({
        subagentId: 'sub_1',
        childSessionId: 'child_1',
        status: 'done' as const,
        summary: `summarised: ${task}`,
      })),
      // The tool factory only calls `run`; the type is the real one so a rename breaks here, not at runtime.
    } as unknown as Parameters<typeof createJobTools>[0]['subagents'];
    const [start, list, output] = createJobTools({ jobs, subagents });

    const started = await start.execute({ task: 'do the thing' }, context('s1')) as {
      job: { id: string; kind: string; status: string };
    };
    expect(started.job.kind).toBe('subagent');
    expect(started.job.status).toBe('running');

    const listed = await list.execute({}, context('s1')) as { text: string; jobs: unknown[] };
    expect(listed.text).toContain(started.job.id);
    expect(listed.jobs).toHaveLength(1);

    const collected = await output.execute({ job_id: started.job.id, wait: true, timeout_ms: 2000 }, context('s1')) as {
      text: string; job: { status: string };
    };
    expect(collected.text).toContain('[status: completed]');
    expect(collected.text).toContain('summarised: do the thing');
    expect(subagents.run).toHaveBeenCalledWith('s1', 'do the thing');
  });

  it('job_kill reports cancellation and already-finished', async () => {
    const jobs = new JobRegistry();
    const subagents = {
      run: vi.fn(async () => new Promise<never>(() => undefined)),
    } as never;
    const [, , , kill] = createJobTools({ jobs, subagents });

    const job = jobs.start({
      kind: 'subagent',
      label: 'long',
      sessionId: 's1',
      run: async () => new Promise<unknown>(() => undefined),
    });
    const cancelled = await kill.execute({ job_id: job.id, reason: 'changed mind' }, context('s1')) as {
      outcome: string;
    };
    expect(cancelled.outcome).toBe('cancellation-requested');

    const done = jobs.start({ kind: 'subagent', label: 'fast', sessionId: 's1', run: async () => 'ok' });
    await jobs.wait(done.id, 's1', 2000);
    const already = await kill.execute({ job_id: done.id }, context('s1')) as { outcome: string };
    expect(already.outcome).toBe('already-finished');
  });

  it('rejects empty ids and unknown jobs', async () => {
    const jobs = new JobRegistry();
    const [, , output, kill] = createJobTools({ jobs, subagents: undefined as never });
    await expect(output.execute({ job_id: '' }, context('s1'))).rejects.toThrow(/job_id/);
    await expect(output.execute({ job_id: 'subagent-missing' }, context('s1'))).rejects.toThrow(/not found/);
    await expect(kill.execute({ job_id: 'subagent-missing' }, context('s1'))).rejects.toThrow(/not found/);
  });

  it('fences jobs by session through the tools', async () => {
    const jobs = new JobRegistry();
    const [, list, output] = createJobTools({ jobs, subagents: undefined as never });
    const job = jobs.start({ kind: 'subagent', label: 'mine', sessionId: 'owner', run: async () => 'ok' });
    await jobs.wait(job.id, 'owner', 2000);

    const foreign = await list.execute({}, context('other')) as { jobs: unknown[] };
    expect(foreign.jobs).toEqual([]);
    await expect(output.execute({ job_id: job.id }, context('other'))).rejects.toThrow(/not found/);
  });
});
