/**
 * Advisory loop-hygiene guard, adapted from deepseek-harness `repeat-tool-reminder`:
 * when the model repeats the exact same tool call (same name, canonically identical
 * arguments) without progress, remind it to change approach or finish. Advisory only —
 * never blocks or rewrites a call. Per-session, in-memory, reset on a new user turn.
 */

export const REPEAT_THRESHOLDS = [3, 5, 8] as const;

/** Bookkeeping tools that must never trip the chain (deepseek excludes `todo_write`). */
const EXCLUDED = new Set([
  'todo_write', 'skill', 'get_goal', 'set_goal', 'exit_plan_mode', 'present',
  'job_list', 'read_spill', 'read_file', 'session_ref', 'list_agents',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalArgs(args: unknown): string {
  try {
    return JSON.stringify(canonicalize(args)) ?? 'null';
  } catch {
    return String(args);
  }
}

function preview(args: string, cap: number): string {
  if (args.length <= cap) return args;
  return `${args.slice(0, cap)}… (+${args.length - cap} more chars)`;
}

export interface RepeatGuardOptions {
  thresholds?: readonly number[];
  argumentsPreviewChars?: number;
}

export class RepeatGuard {
  private chains = new Map<string, { key: string; count: number }>();
  private thresholds: readonly number[];
  private previewChars: number;

  constructor(options: RepeatGuardOptions = {}) {
    this.thresholds = options.thresholds ?? REPEAT_THRESHOLDS;
    this.previewChars = options.argumentsPreviewChars ?? 500;
  }

  reset(sessionId: string): void {
    this.chains.delete(sessionId);
  }

  /**
   * Note one dispatched call. Returns a reminder when the count hits a configured
   * threshold, otherwise null. Untracked (excluded) calls are transparent: they
   * neither increment nor reset the chain.
   */
  note(sessionId: string, name: string, args: unknown): string | null {
    if (EXCLUDED.has(name)) return null;
    const key = `${name}\n${canonicalArgs(args)}`;
    const current = this.chains.get(sessionId);
    const count = current && current.key === key ? current.count + 1 : 1;
    this.chains.set(sessionId, { key, count });

    if (!this.thresholds.includes(count)) return null;
    const [first] = this.thresholds;
    if (count === first) {
      return 'You are repeating the exact same tool call with identical arguments. '
        + 'Carefully analyze the previous result before calling again: if the task is not complete, '
        + 'try a different approach or different arguments instead of repeating the call.';
    }
    return [
      'Repeated tool call detected:',
      `- tool: ${name}`,
      `- consecutive_calls: ${count}`,
      `- arguments: ${preview(canonicalArgs(args), this.previewChars)}`,
      'The repeated calls are not making progress. Do not call this tool with these exact arguments '
      + 'again. Inspect the latest result and choose a different action, different arguments, or '
      + 'finish the task if enough evidence has been gathered.',
    ].join('\n');
  }
}
