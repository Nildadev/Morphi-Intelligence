import { createId } from './shared/id';
import type { AgentLoop } from './agent/loop';
import type { EventStore } from './events/store';
import { createEmit } from './events/emit';
import type { SessionStore } from './session/store';
import { deriveMessages } from './session/projections';
import type { ToolRegistry } from './tools/registry';

/**
 * Ran one detached task in a child session (Tasks 27/29): the child has its own event log, a
 * tool subset (approval-free tools only — a subagent nobody watches must never hang on an
 * approval), and the parent receives the `subagent/start|end` protocol events, which the
 * transcript renders as a collapsible card ("Ran N tools", outcome, duration). Max depth 2
 * and max 3 concurrent children per process.
 */
export const SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_MAX_CONCURRENT = 3;

/** Derive a short deepseek-style member label from a task ("Research protocol framing…" → `protocol`). */
export function memberNameOf(task: string, index: number): string {
  const words = task.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const stop = new Set(['research', 'extract', 'fix', 'implement', 'the', 'a', 'an', 'for', 'to']);
  const pick = words.find((word) => !stop.has(word)) ?? words[0] ?? `member-${index + 1}`;
  return pick || `member-${index + 1}`;
}

export interface SubagentResult {
  subagentId: string;
  childSessionId: string;
  status: 'done' | 'error' | 'cancelled';
  summary: string;
}

/** What the transcript card renders: task, outcome, and how much work the child did. */
export interface SubagentCardData {
  subagentId: string;
  task: string;
  status: 'done' | 'error' | 'cancelled';
  summary: string;
  childSessionId: string;
  toolCount: number;
  failedToolCount: number;
  durationMs: number;
}

export class SubagentDepthError extends Error {
  readonly code = 'SUBAGENT_DEPTH_LIMIT';

  constructor() {
    super('Subagent depth limit reached');
    this.name = 'SubagentDepthError';
  }
}

export class SubagentBusyError extends Error {
  readonly code = 'SUBAGENT_BUSY';

  constructor() {
    super('Too many subagents are already running');
    this.name = 'SubagentBusyError';
  }
}

/** Identity returned immediately on start (deepseek `startActivation`). */
export interface SubagentStart {
  subagentId: string;
  childSessionId: string;
}

export class SubagentRunner {
  private readonly running = new Set<string>();
  private readonly depth = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private deps: {
    events: EventStore;
    sessions: SessionStore;
    agent: AgentLoop;
    tools: ToolRegistry;
    llm?: { resolve: (selection: string) => { model: { id: string } } };
    /** Completion delivery: busy parents get an inbox steer, idle parents get a wake turn. */
    inbox?: { push: (sessionId: string, content: string, source?: 'steer' | 'notice') => number };
    busy?: (sessionId: string) => boolean;
    wake?: (sessionId: string, notice: string) => void;
  }) {}

  /** Approval-free tools only: nothing in the subset can park waiting on a human decision. */
  private safeSubset(): string[] {
    return this.deps.tools.list()
      .filter((tool) => tool.approval === 'auto')
      .map((tool) => tool.name);
  }

  /** The exact model the parent turn last ran with, so the child never re-resolves `auto` differently. */
  private parentModelSelection(parentId: string, fallback: string | undefined): string {
    const rows = this.deps.events.list(parentId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].type !== 'turn/start') continue;
      const selection = (rows[index].payload as { modelSelection?: unknown }).modelSelection;
      if (typeof selection === 'string' && selection.trim() !== '') return selection;
    }
    return fallback ?? 'auto';
  }

  private promises = new Map<string, Promise<SubagentResult>>();

  /**
   * Managed delegation (deepseek `startActivation`): admission is synchronous, execution is
   * owned by the runtime. Returns the child identity immediately; the completion notice
   * (durable `subagent/end` + inbox/wake) arrives independently.
   */
  start(parentId: string, task: string): SubagentStart {
    const parentDepth = this.depth.get(parentId) ?? 0;
    if (parentDepth >= SUBAGENT_MAX_DEPTH) throw new SubagentDepthError();
    if (this.running.size >= SUBAGENT_MAX_CONCURRENT) throw new SubagentBusyError();

    const parent = this.deps.sessions.get(parentId);
    if (!parent) throw new Error('SESSION_NOT_FOUND');

    // Resolve `auto` once to a concrete id (deepseek prepareCall pattern) so the child cannot
    // re-pick an expensive 65k-output model that the parent turn never used.
    const rawSelection = this.parentModelSelection(parentId, parent.modelSelection);
    let modelSelection = rawSelection;
    if (this.deps.llm && (rawSelection === 'auto' || rawSelection === '')) {
      try {
        modelSelection = this.deps.llm.resolve('auto').model.id;
      } catch {
        modelSelection = 'auto';
      }
    }

    const subagentId = createId('sub');
    // Deepseek-style: the child is named by its task alone (no "Subagent:" prefix) and lives
    // inside the parent's team — flagged is_subagent so `list()` never shows it in the sidebar.
    const title = task.replace(/\s+/g, ' ').trim().slice(0, 80);
    const child = this.deps.sessions.create(parent.projectId, title, modelSelection, {
      isSubagent: true,
      parentSessionId: parentId,
    });
    this.depth.set(child.id, parentDepth + 1);
    this.running.add(child.id);

    this.deps.events.append(parentId, [{
      type: 'subagent/start',
      payload: { subagentId, parentSessionId: parentId, childSessionId: child.id, task },
    }]);

    const controller = new AbortController();
    this.controllers.set(child.id, controller);
    const startedAt = Date.now();
    const execution = (async (): Promise<SubagentResult> => {
      try {
        const outcome = await this.deps.agent.runTurn({
          sessionId: child.id,
          content: task,
          modelSelection,
          trigger: 'user',
          toolSubset: this.safeSubset(),
          // Smaller cap keeps the child under low-credit OpenRouter balances (affordable ≈ 15k).
          maxTokens: 4096,
          signal: controller.signal,
        }, createEmit(this.deps.events, child.id));
        const timeline = deriveMessages(this.deps.events.list(child.id));
        const lastAssistant = timeline.filter((message) => message.role === 'assistant').pop();
        // A failed child produced no reply: the best honest summary is the last provider error.
        const summary = lastAssistant?.content ?? this.lastErrorOf(child.id)
          ?? (outcome.status === 'completed' ? 'Subagent xong.' : 'Subagent không trả lời được.');
        const status: SubagentResult['status'] = outcome.status === 'completed' ? 'done' : outcome.status === 'cancelled' ? 'cancelled' : 'error';
        const stats = this.toolStats(child.id);

        this.deps.events.append(parentId, [{
          type: 'subagent/end',
          payload: {
            subagentId,
            status,
            summary,
            toolCount: stats.toolCount,
            failedToolCount: stats.failedToolCount,
            durationMs: Date.now() - startedAt,
          },
        }]);
        // Parent delivery: busy → inbox steer next step; idle → wake turn (deepseek rules).
        this.deliver(parentId, child.id, status, summary);
        return { subagentId, childSessionId: child.id, status, summary };
      } finally {
        this.running.delete(child.id);
        this.controllers.delete(child.id);
        this.promises.delete(child.id);
        // The depth entry stays: later spawns from this child (the session persists) must still
        // see its tree depth, even after its own turn has finished.
      }
    })();
    this.promises.set(child.id, execution);
    // Fire-and-forget: the child owns the work independently of any caller (deepseek activation).
    void execution.catch(() => undefined);
    return { subagentId, childSessionId: child.id };
  }

  private deliver(parentId: string, childId: string, status: string, summary: string): void {
    const notice = `Background subagent ${childId} finished [status: ${status}]. ${summary}`;
    if (this.deps.busy?.(parentId)) {
      this.deps.inbox?.push(parentId, notice, 'notice');
      return;
    }
    if (this.deps.wake) {
      this.deps.wake(parentId, notice);
      return;
    }
    this.deps.inbox?.push(parentId, notice, 'notice');
  }

  /** Await a started child (programmatic callers: workflows, jobs). */
  async wait(childSessionId: string): Promise<SubagentResult> {
    const promise = this.promises.get(childSessionId);
    if (!promise) throw new Error(`subagent: no running activation for "${childSessionId}"`);
    return promise;
  }

  /** Back-compat awaited one-shot (internal callers that need the result). */
  async run(parentId: string, task: string): Promise<SubagentResult> {
    const { childSessionId } = this.start(parentId, task);
    return this.wait(childSessionId);
  }

  /** All direct + indirect descendants of a root session, in stable spawn order. */
  listTree(rootId: string): Array<{
    subagentId: string;
    childSessionId: string;
    task: string;
    status: 'running' | 'inactive';
    /** Short member label (deepseek grid name), e.g. `protocol` from "Research protocol framing…". */
    memberName: string;
    durationMs?: number;
    toolCount?: number;
  }> {
    const out: Array<{
      subagentId: string;
      childSessionId: string;
      task: string;
      status: 'running' | 'inactive';
      memberName: string;
      durationMs?: number;
      toolCount?: number;
    }> = [];
    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const event of this.deps.events.list(parentId)) {
        if (event.type !== 'subagent/start') continue;
        const payload = event.payload as { subagentId: string; childSessionId: string; task: string };
        out.push({
          subagentId: payload.subagentId,
          childSessionId: payload.childSessionId,
          task: payload.task,
          status: this.running.has(payload.childSessionId) ? 'running' : 'inactive',
          memberName: memberNameOf(payload.task, out.length),
          durationMs: this.lastDurationOf(parentId, payload.subagentId),
          toolCount: this.toolStats(payload.childSessionId).toolCount,
        });
        queue.push(payload.childSessionId);
      }
    }
    return out;
  }

  private lastDurationOf(parentId: string, subagentId: string): number | undefined {
    for (const event of this.deps.events.list(parentId).reverse()) {
      if (event.type !== 'subagent/end') continue;
      const payload = event.payload as { subagentId: string; durationMs?: number };
      if (payload.subagentId === subagentId && typeof payload.durationMs === 'number') return payload.durationMs;
    }
    const child = this.deps.sessions.get(this.childIdOf(parentId, subagentId));
    if (child) return Math.max(0, Date.now() - child.createdAt);
    return undefined;
  }

  private childIdOf(parentId: string, subagentId: string): string {
    for (const event of this.deps.events.list(parentId)) {
      if (event.type !== 'subagent/start') continue;
      const payload = event.payload as { subagentId: string; childSessionId: string };
      if (payload.subagentId === subagentId) return payload.childSessionId;
    }
    return '';
  }

  /** Continuable follow-up: one more turn in an existing child session. */
  async followup(parentId: string, childSessionId: string, message: string): Promise<SubagentResult> {
    if (!this.isDescendant(parentId, childSessionId)) throw new Error(`subagent: session "${childSessionId}" is not a descendant of "${parentId}"`);
    if (this.running.has(childSessionId)) throw new SubagentBusyError();
    const child = this.deps.sessions.get(childSessionId);
    if (!child) throw new Error('SESSION_NOT_FOUND');
    const subagentId = createId('sub');
    this.running.add(childSessionId);
    const controller = new AbortController();
    this.controllers.set(childSessionId, controller);
    this.deps.events.append(parentId, [{
      type: 'subagent/start',
      payload: { subagentId, parentSessionId: parentId, childSessionId, task: message },
    }]);
    try {
      const startedAt = Date.now();
      const outcome = await this.deps.agent.runTurn({
        sessionId: childSessionId,
        content: message,
        modelSelection: child.modelSelection ?? 'auto',
        trigger: 'user',
        toolSubset: this.safeSubset(),
        maxTokens: 4096,
        signal: controller.signal,
      }, createEmit(this.deps.events, childSessionId));
      const timeline = deriveMessages(this.deps.events.list(childSessionId));
      const lastAssistant = timeline.filter((m) => m.role === 'assistant').pop();
      const summary = lastAssistant?.content ?? this.lastErrorOf(childSessionId) ?? 'Subagent không trả lời được.';
      const status: SubagentResult['status'] = outcome.status === 'completed' ? 'done' : outcome.status === 'cancelled' ? 'cancelled' : 'error';
      const stats = this.toolStats(childSessionId);
      this.deps.events.append(parentId, [{
        type: 'subagent/end',
        payload: { subagentId, status, summary, toolCount: stats.toolCount, failedToolCount: stats.failedToolCount, durationMs: Date.now() - startedAt },
      }]);
      return { subagentId, childSessionId, status, summary };
    } finally {
      this.running.delete(childSessionId);
      this.controllers.delete(childSessionId);
    }
  }

  /** Interrupt a running child turn; queued inbox stays parked for a later follow-up. */
  interrupt(childSessionId: string): boolean {
    const controller = this.controllers.get(childSessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private isDescendant(rootId: string, candidate: string): boolean {
    return this.listTree(rootId).some((entry) => entry.childSessionId === candidate);
  }

  /** Child-log facts the parent card renders: how many tools ran and how many failed. */
  private toolStats(childId: string): { toolCount: number; failedToolCount: number } {
    let toolCount = 0;
    let failedToolCount = 0;
    for (const event of this.deps.events.list(childId)) {
      if (event.type === 'tool/call') toolCount += 1;
      if (event.type === 'tool/result' && (event.payload as { status: string }).status === 'error') {
        failedToolCount += 1;
      }
    }
    return { toolCount, failedToolCount };
  }

  /** The newest failure message the child logged, so a dead turn explains itself in the parent. */
  private lastErrorOf(childId: string): string | undefined {
    const rows = this.deps.events.list(childId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].type === 'assistant/attempt') {
        return ((rows[index].payload as { error?: string }).error ?? '').trim() || undefined;
      }
    }
    return undefined;
  }
}
