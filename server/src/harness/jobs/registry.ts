import { randomUUID } from 'node:crypto';

/**
 * Background-job registry, adapted from deepseek-harness `dsh-jobs` + `dsh-jobs-local`:
 * one in-process registry, owner-fenced by session id, first-wins settlement.
 * Jobs die with the process; durable execution across restarts needs a different backend.
 */

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

export interface JobView {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  progress?: string;
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

export interface JobHandle {
  push(text: string, stream?: 'stdout' | 'stderr'): void;
  setProgress(text: string): void;
  signal: AbortSignal;
}

interface JobRecord {
  id: string;
  kind: string;
  label: string;
  sessionId?: string;
  status: JobStatus;
  progress?: string;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  /** Bounded output ring (stdout/stderr interleaved in push order). */
  chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }>;
  /** Model cursor: output consumed by job_output reads. */
  cursor: number;
  result?: unknown;
  runError?: string;
  controller: AbortController;
  settled: Promise<JobView>;
  notify: () => void;
  observedByWait: boolean;
}

export interface StartJobSpec {
  kind: string;
  label: string;
  sessionId?: string;
  run: (handle: JobHandle) => Promise<unknown>;
}

function shortId(kind: string): string {
  return `${kind}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const MAX_CHUNKS = 500;

export class JobRegistry {
  private jobs = new Map<string, JobRecord>();
  private listeners = new Set<(view: JobView) => void>();

  subscribe(listener: (view: JobView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(spec: StartJobSpec): JobView {
    const id = shortId(spec.kind);
    const controller = new AbortController();
    let notifyFn: () => void = () => undefined;
    const settled = new Promise<JobView>((resolve) => { notifyFn = () => resolve(this.viewOf(record)); });
    const record: JobRecord = {
      id,
      kind: spec.kind,
      label: spec.label.slice(0, 200),
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
      status: 'running',
      startedAt: Date.now(),
      chunks: [],
      cursor: 0,
      controller,
      settled,
      notify: notifyFn,
      observedByWait: false,
    };
    this.jobs.set(id, record);
    this.emit(record);

    const handle: JobHandle = {
      signal: controller.signal,
      push: (text, stream = 'stdout') => {
        if (record.status !== 'running' && record.status !== 'stopping') return;
        record.chunks.push({ stream, text });
        if (record.chunks.length > MAX_CHUNKS) record.chunks.splice(0, record.chunks.length - MAX_CHUNKS);
      },
      setProgress: (text) => {
        record.progress = text.slice(0, 500);
      },
    };

    void (async () => {
      try {
        const result = await spec.run(handle);
        if (controller.signal.aborted) {
          record.status = 'killed';
          record.detail = 'killed';
        } else {
          record.status = 'completed';
          record.result = result;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          record.status = 'killed';
          record.detail = 'killed';
        } else {
          record.status = 'failed';
          record.runError = error instanceof Error ? error.message : String(error);
          record.detail = record.runError;
        }
      } finally {
        record.endedAt = Date.now();
        record.notify();
        this.emit(record);
      }
    })();

    return this.viewOf(record);
  }

  list(sessionId?: string): JobView[] {
    return [...this.jobs.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((record) => this.viewOf(record));
  }

  get(id: string, sessionId?: string): JobView | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    if (record.sessionId !== undefined && sessionId !== undefined && record.sessionId !== sessionId) return undefined;
    if (record.sessionId === undefined && sessionId !== undefined) return undefined;
    return this.viewOf(record);
  }

  /** Consuming read: output since the last read (model cursor), plus terminal result once. */
  read(id: string, sessionId: string): { text: string; status: JobStatus; result?: unknown; detail?: string } | undefined {
    const record = this.owned(id, sessionId);
    if (!record) return undefined;
    const fresh = record.chunks.slice(record.cursor);
    record.cursor = record.chunks.length;
    const stdout = fresh.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.text).join('');
    const stderr = fresh.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.text).join('');
    let text = stdout;
    if (stderr) text += (text ? '\n' : '') + `[stderr]\n${stderr}`;
    if (fresh.length === 0 && text === '') text = '(no new output)';
    const terminal = record.status === 'completed' || record.status === 'killed' || record.status === 'failed';
    return {
      text,
      status: record.status,
      ...(terminal && record.result !== undefined ? { result: record.result } : {}),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    };
  }

  async wait(id: string, sessionId: string, timeoutMs = 30_000): Promise<JobView | undefined> {
    const record = this.owned(id, sessionId);
    if (!record) return undefined;
    if (record.status !== 'running' && record.status !== 'stopping') return this.viewOf(record);
    record.observedByWait = true;
    const capped = Math.max(0, Math.min(timeoutMs, 600_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        record.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, capped);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.viewOf(record);
  }

  kill(id: string, sessionId: string, reason?: string): JobView | undefined {
    const record = this.owned(id, sessionId);
    if (!record) return undefined;
    if (record.status === 'completed' || record.status === 'killed' || record.status === 'failed') {
      return this.viewOf(record);
    }
    record.status = 'stopping';
    record.detail = reason ?? 'killed';
    record.controller.abort();
    this.emit(record);
    return this.viewOf(record);
  }

  remove(id: string, sessionId: string): boolean {
    const record = this.owned(id, sessionId);
    if (!record) return false;
    if (record.status === 'running' || record.status === 'stopping') return false;
    this.jobs.delete(id);
    return true;
  }

  clearSession(sessionId: string): void {
    for (const record of [...this.jobs.values()]) {
      if (record.sessionId !== sessionId) continue;
      if (record.status === 'running' || record.status === 'stopping') record.controller.abort();
    }
    // Abort is cooperative: records settle in the run finally block. Settled records are
    // dropped now so a wiped session leaves no stale list entries.
    for (const record of [...this.jobs.values()]) {
      if (record.sessionId === sessionId && record.status !== 'running' && record.status !== 'stopping') {
        this.jobs.delete(record.id);
      }
    }
  }

  private owned(id: string, sessionId: string): JobRecord | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    // Unowned jobs are open to any caller (deepseek contract); owned jobs are fenced.
    if (record.sessionId !== undefined && record.sessionId !== sessionId) return undefined;
    return record;
  }

  private viewOf(record: JobRecord): JobView {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      status: record.status,
      ...(record.progress !== undefined ? { progress: record.progress } : {}),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
      startedAt: record.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    };
  }

  private emit(record: JobRecord): void {
    const view = this.viewOf(record);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // Listener failure never breaks the registry.
      }
    }
  }
}
