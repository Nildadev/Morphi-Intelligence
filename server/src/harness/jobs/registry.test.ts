import { describe, expect, it } from 'vitest';
import { JobRegistry } from './registry';

describe('JobRegistry', () => {
  it('starts a job, streams output, and settles completed', async () => {
    const jobs = new JobRegistry();
    const job = jobs.start({
      kind: 'task',
      label: 'echo',
      sessionId: 's1',
      run: async (handle) => {
        handle.push('line1\n');
        handle.push('line2', 'stderr');
        return 'done-result';
      },
    });
    expect(job.id).toMatch(/^task-/);
    expect(job.status).toBe('running');

    const waited = await jobs.wait(job.id, 's1', 2000);
    expect(waited?.status).toBe('completed');

    const read = jobs.read(job.id, 's1');
    expect(read?.text).toContain('line1');
    expect(read?.text).toContain('[stderr]');
    expect(read?.result).toBe('done-result');
    expect(read?.status).toBe('completed');

    // Second read is empty (cursor consumed).
    expect(jobs.read(job.id, 's1')?.text).toBe('(no new output)');
  });

  it('settles failed when the run throws', async () => {
    const jobs = new JobRegistry();
    const job = jobs.start({
      kind: 'task',
      label: 'boom',
      sessionId: 's1',
      run: async () => { throw new Error('disk on fire'); },
    });
    const waited = await jobs.wait(job.id, 's1', 2000);
    expect(waited?.status).toBe('failed');
    expect(waited?.detail).toContain('disk on fire');
  });

  it('kills a running job and settles as killed', async () => {
    const jobs = new JobRegistry();
    let release: (() => void) | undefined;
    const job = jobs.start({
      kind: 'task',
      label: 'long',
      sessionId: 's1',
      run: async (handle) => {
        await new Promise<void>((resolve) => {
          release = resolve;
          handle.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'late';
      },
    });
    const killed = jobs.kill(job.id, 's1', 'no longer matters');
    expect(killed?.status).toBe('stopping');
    const waited = await jobs.wait(job.id, 's1', 2000);
    expect(waited?.status).toBe('killed');
    release?.();
  });

  it('fences unowned access by session', async () => {
    const jobs = new JobRegistry();
    const job = jobs.start({
      kind: 'task',
      label: 'mine',
      sessionId: 'owner',
      run: async () => 'ok',
    });
    await jobs.wait(job.id, 'owner', 2000);
    expect(jobs.get(job.id, 'other')).toBeUndefined();
    expect(jobs.read(job.id, 'other')).toBeUndefined();
    expect(jobs.kill(job.id, 'other')).toBeUndefined();
    expect(jobs.list('other')).toEqual([]);
    expect(jobs.list('owner')).toHaveLength(1);
  });

  it('wait times out and leaves the job running', async () => {
    const jobs = new JobRegistry();
    const job = jobs.start({
      kind: 'task',
      label: 'slow',
      sessionId: 's1',
      run: async (handle) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return 'late';
      },
    });
    const timedOut = await jobs.wait(job.id, 's1', 10);
    expect(timedOut?.status).toBe('running');
    // Cleanup: kill so the test does not leak the timer.
    jobs.kill(job.id, 's1', 'test cleanup');
  });

  it('emits view events and removes settled records', async () => {
    const jobs = new JobRegistry();
    const seen: string[] = [];
    const unsub = jobs.subscribe((view) => seen.push(`${view.id}:${view.status}`));
    const job = jobs.start({
      kind: 'task',
      label: 'x',
      sessionId: 's1',
      run: async () => 'ok',
    });
    await jobs.wait(job.id, 's1', 2000);
    expect(seen.some((entry) => entry.endsWith(':completed'))).toBe(true);
    unsub();
    expect(jobs.remove(job.id, 's1')).toBe(true);
    expect(jobs.get(job.id, 's1')).toBeUndefined();
    // Running jobs cannot be removed.
    const running = jobs.start({ kind: 'task', label: 'y', sessionId: 's1', run: async () => new Promise(() => undefined) });
    expect(jobs.remove(running.id, 's1')).toBe(false);
    jobs.kill(running.id, 's1', 'cleanup');
  });

  it('clearSession aborts running jobs for that session', async () => {
    const jobs = new JobRegistry();
    const job = jobs.start({
      kind: 'task',
      label: 'long',
      sessionId: 's1',
      run: async (handle) => {
        await new Promise<void>((resolve) => {
          handle.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    jobs.clearSession('s1');
    const waited = await jobs.wait(job.id, 's1', 2000);
    expect(waited?.status).toBe('killed');
  });
});
