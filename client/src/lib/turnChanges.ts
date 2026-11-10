import type { DerivedToolCall } from '../types';

/**
 * Workspace-change summary for one turn — the Morphi counterpart of ZCode's
 * `ConversationFileSummaryPanel` header ("N files changed  +A −D").
 *
 * The data already exists: every edit-shaped Studio tool carries its before/after text in
 * `args`, and `ToolCallCard` has computed a per-call diff since Task 21. What was missing is
 * the *aggregate* the user actually reads: how many files this turn touched, and the total
 * line churn. Without it the collapsed "Đã làm trong 12s" line says how long the agent worked
 * but not what it did.
 *
 * Design constraints that come from the real payloads:
 *  - A turn can edit the same file more than once (`studio.edit_script` twice). Counting rows
 *    would over-report, so the summary keys by path and keeps the LAST diff for that path —
 *    the last write is what the workspace holds.
 *  - `studio.multi_edit` is one call that touches several files; its `args` is an array of
 *    per-file edits, so it expands into N entries.
 *  - Anything that cannot be read as a path is skipped rather than guessed: a wrong count is
 *    worse than no count (same rule as the provider error messages).
 */

export type DiffOp = { kind: 'eq' | 'add' | 'del'; oldNo: number; newNo: number; text: string };

/** Tools whose `args` describe a file write. Kept in sync with `ToolCallCard`'s diff viewer. */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'studio.multi_edit',
  'studio.execute_luau',
  'studio.write_script',
  'studio.edit_script',
  'studio.create_script',
]);

/**
 * Tiny line LCS for the diff viewer. Capped: a file over 2000 lines falls back to
 * "all added / all removed", which is still truthful about churn and avoids an O(n·m)
 * allocation on a pathological input.
 */
export function diffLines(oldText: string, newText: string): { ops: DiffOp[]; added: number; removed: number } {
  const oldLines = oldText.length ? oldText.split('\n') : [];
  const newLines = newText.length ? newText.split('\n') : [];
  if (oldLines.length > 2000 || newLines.length > 2000) {
    return {
      ops: newLines.map((text, index) => ({ kind: 'add' as const, oldNo: 0, newNo: index + 1, text })),
      added: newLines.length,
      removed: oldLines.length,
    };
  }
  const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'eq', oldNo: i + 1, newNo: j + 1, text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', oldNo: i + 1, newNo: 0, text: oldLines[i] });
      removed++; i++;
    } else {
      ops.push({ kind: 'add', oldNo: 0, newNo: j + 1, text: newLines[j] });
      added++; j++;
    }
  }
  while (i < oldLines.length) { ops.push({ kind: 'del', oldNo: i + 1, newNo: 0, text: oldLines[i] }); removed++; i++; }
  while (j < newLines.length) { ops.push({ kind: 'add', oldNo: 0, newNo: j + 1, text: newLines[j] }); added++; j++; }
  return { ops, added, removed };
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  ops: DiffOp[];
}

const textOf = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
};

const OLD_KEYS = ['old', 'old_string', 'oldText', 'before'] as const;
const NEW_KEYS = ['source', 'code', 'script_content', 'content', 'new_string', 'newText'] as const;
const PATH_KEYS = ['path', 'filename', 'script', 'target', 'file'] as const;

/** One file edit described by a flat args object, or null when the shape is not a file write. */
function changeOfArgs(args: Record<string, unknown>): FileChange | null {
  const pathValue = textOf(args, PATH_KEYS);
  if (pathValue.trim() === '') return null;
  const oldText = textOf(args, OLD_KEYS);
  const newText = textOf(args, NEW_KEYS);
  if (newText === '' && oldText === '') return { path: pathValue, added: 0, removed: 0, ops: [] };
  const { ops, added, removed } = diffLines(oldText, newText);
  return { path: pathValue, added, removed, ops };
}

/**
 * Every file change a single tool call made. `studio.multi_edit` carries an array (either at
 * `args.edits` or as the args value itself), so one call can yield many files.
 */
export function changesOfCall(call: DerivedToolCall): FileChange[] {
  if (call.status !== 'done' && call.status !== 'error') return [];
  if (!EDIT_TOOL_NAMES.has(call.name)) return [];
  const args = call.args;
  if (Array.isArray(args)) {
    return args.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object') return [];
      const change = changeOfArgs(entry as Record<string, unknown>);
      return change ? [change] : [];
    });
  }
  if (args === null || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const edits = record.edits;
  if (Array.isArray(edits)) {
    const nested = edits.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object') return [];
      const change = changeOfArgs(entry as Record<string, unknown>);
      return change ? [change] : [];
    });
    // A `multi_edit` may ALSO carry its own flat path; prefer the explicit list when present.
    if (nested.length > 0) return nested;
  }
  const single = changeOfArgs(record);
  return single ? [single] : [];
}

export interface TurnChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  /** Per-file totals, in first-seen order; the last write to a path wins. */
  changes: FileChange[];
}

/**
 * Aggregate the edits of one turn. Returns null when nothing was written, so callers render
 * no line at all instead of a "0 files changed" that reads like a failure.
 */
export function summarizeTurnChanges(calls: readonly DerivedToolCall[]): TurnChangeSummary | null {
  const byPath = new Map<string, FileChange>();
  for (const call of calls) {
    for (const change of changesOfCall(call)) {
      // Last write wins: a file edited twice in one turn is one changed file whose final
      // diff is the one the workspace actually holds.
      byPath.set(change.path, change);
    }
  }
  if (byPath.size === 0) return null;
  const changes = [...byPath.values()];
  return {
    files: changes.length,
    additions: changes.reduce((sum, change) => sum + change.added, 0),
    deletions: changes.reduce((sum, change) => sum + change.removed, 0),
    changes,
  };
}
