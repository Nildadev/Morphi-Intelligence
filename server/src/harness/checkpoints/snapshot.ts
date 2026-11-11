import type { McpGateway } from '../tools/types';
import {
  inspectInstance,
  readScriptSource,
  restorableProperties,
  type SnapshotEntry,
  type InverseStep,
} from './studioWire';

export type { SnapshotEntry, InverseStep };

/** The restored state of a target before the mutation ran. */
export interface PreStateSnapshot {
  entries: SnapshotEntry[];
  /** Tools whose inverse is known for every target. Empty means "not restorable". */
  inverse: InverseStep[];
  /** Why a target could not be snapshotted, when some could not. */
  notes: string[];
}

/** One target's state AFTER the mutation landed, captured by re-reading it. */
export type PostStateEntry =
  | { kind: 'script'; path: string; source: string }
  | { kind: 'properties'; path: string; properties: Record<string, unknown> };

/**
 * What the turn itself wrote, per target.
 *
 * Without this, drift detection can only compare the live workspace with the PRE-state — and after a
 * successful mutation the live workspace legitimately differs from it. Measured live before this
 * existed: a script hand-edited to `local V = 99` AFTER the turn (the turn had written `local V = 2`)
 * previewed as `clean: true` and the undo silently overwrote that hand edit, which is exactly what
 * the plan forbids. Comparing against the POST-state makes the three cases distinguishable:
 *   live == post ⇒ the turn's own write, safe to invert;
 *   live == pre  ⇒ already back at the old state, a no-op;
 *   neither      ⇒ someone edited it after the turn, so refuse (never overwrite).
 *
 * `inserted` targets are not captured: their inverse is a delete, so there is no content to compare.
 */
export interface PostStateSnapshot {
  entries: PostStateEntry[];
  /** Targets whose post-state could not be read; drift then falls back to the pre-state comparison. */
  notes: string[];
}


/**
 * Pre-mutation snapshot — Phase 3 of `docs/superpowers/plans/morphi-git.md`.
 *
 * Phase 2 recorded *that* a mutation happened (`restorable: false`, "no pre-state"). This module
 * captures the pre-state so an inverse actually exists. The rule from the plan is absolute: a
 * checkpoint may only claim `restorable: true` when this module produced a snapshot whose restore
 * path is known; every other case keeps `restorable: false` with a reason a user can read.
 *
 * What can be snapshotted, and how (measured live on `Place1`, Roblox Studio MCP server):
 *  - **Script source** — read via `script_read` (`target_file`, dot notation), which returns
 *    line-numbered text (`1→…`). Gives the exact source to write back through `multi_edit`.
 *  - **Inserted asset / instance** — the inverse is a delete; `studioWire.deleteInstance` runs Luau
 *    to `:Destroy()` the path (the official server ships no delete tool).
 *  - **Instance properties** — read via `inspect_instance` (`path`); re-applied best-effort via Luau.
 *  - Everything else (arbitrary `execute_luau`, deleted instances with children) has no safe
 *    inverse from a read: those stay non-restorable instead of guessing.
 *
 * The snapshot is taken BEFORE the mutating call runs and is best-effort: a failed snapshot must
 * not block the user's tool call, it only downgrades the checkpoint to non-restorable.
 */

/** Tool names that write script source — the snapshot keys off these to pre-read old source. */
const SCRIPT_WRITE_TOOLS = [
  'studio.write_script', 'studio.edit_script', 'studio.create_script', 'studio.multi_edit',
  'multi_edit', 'write_script', 'edit_script', 'create_script',
] as const;
/** Tool names whose inverse is "delete what was inserted". */
const INSERT_TOOLS = ['studio.insert_asset', 'studio.insert_instance', 'insert_asset', 'insert_instance'] as const;

const PATH_KEYS = ['path', 'file_path', 'script', 'target', 'target_file', 'targetPath', 'scriptPath', 'instancePath', 'filename', 'assetId'] as const;

function pathOf(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Every script path a `multi_edit` / `edits` array touches, plus its own path. */
function scriptPathsOf(args: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 2 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['edits', 'changes', 'files']) {
        if (Array.isArray(record[key])) visit(record[key], depth + 1);
      }
      const path = pathOf(record);
      if (path !== null) found.add(path);
    }
  };
  visit(args, 0);
  return [...found];
}

/** The source text a write tool is about to put in, when the args carry it (used to detect creates). */
function sourceOf(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of ['source', 'code', 'content', 'new_string', 'newText', 'script_content'] as const) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  // Inside an edits[] entry the new text is `new_string`.
  if (Array.isArray(record.edits)) {
    const joined = (record.edits as Array<{ new_string?: string }>)
      .map((edit) => edit?.new_string ?? '')
      .join('');
    if (joined) return joined;
  }
  return null;
}

/**
 * Capture what a mutating call is about to change. Never throws: a snapshot failure degrades the
 * checkpoint, it does not fail the turn.
 */
export async function snapshotPreState(
  mcp: McpGateway,
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<PreStateSnapshot> {
  const entries: SnapshotEntry[] = [];
  const inverse: InverseStep[] = [];
  const notes: string[] = [];

  const isScriptWrite = (SCRIPT_WRITE_TOOLS as readonly string[]).includes(toolName);
  const isInsert = (INSERT_TOOLS as readonly string[]).includes(toolName);

  if (isScriptWrite) {
    const paths = scriptPathsOf(args);
    if (paths.length === 0) {
      notes.push('Không đọc được đường dẫn script từ tham số của công cụ.');
    }
    for (const path of paths) {
      const source = await readScriptSource(mcp, path, signal);
      if (source === null) {
        // The read found nothing. That is a CREATE only when the ARGS say so: a dedicated create
        // tool, or a `multi_edit` edit that starts from an empty `old_string` (measured semantics:
        // empty old_string is how the real tool writes a new script). Otherwise a failed read on an
        // EXISTING script must stay a note — claiming "inserted" here would make the restore DELETE
        // the user's script instead of restoring its source.
        if (declaresCreate(toolName, args)) {
          entries.push({ kind: 'inserted', path });
          inverse.push({ tool: 'delete_instance', path });
          continue;
        }
        notes.push(`Không đọc được nguồn hiện tại của ${path} — không có bản sao để khôi phục.`);
        continue;
      }
      entries.push({ kind: 'script', path, source });
      inverse.push({ tool: 'script_write', path, source });
    }
  } else if (isInsert) {
    const path = pathOf(args);
    if (path === null) {
      notes.push('Không đọc được đối tượng được chèn từ tham số của công cụ.');
    } else {
      entries.push({ kind: 'inserted', path });
      inverse.push({ tool: 'delete_instance', path });
    }
  } else {
    // Property writes and arbitrary Luau: snapshot the property bag when the path is known, so the
    // restore engine can at least attempt to re-apply it (verified by re-inspect afterwards).
    const path = pathOf(args);
    if (path !== null) {
      const properties = await inspectInstance(mcp, path, signal);
      if (properties !== null) {
        // A raw `inspect_instance` bag is lossy (flattened pseudo-paths, stringified Vector3/enums).
        // Scalars are kept as candidates and `setInstanceProperties` decides key by key, recording
        // what this build refuses — see `restorableProperties`.
        const restorable = restorableProperties(properties);
        if (Object.keys(restorable).length === 0) {
          notes.push(`Không có thuộc tính nào của ${path} khôi phục được an toàn.`);
        } else {
          entries.push({ kind: 'properties', path, properties: restorable });
          inverse.push({ tool: 'set_properties', path, properties: restorable });
        }
      } else {
        notes.push(`Không có inverse an toàn cho ${toolName} trên ${path}.`);
      }
    } else {
      notes.push(`Không có inverse an toàn cho ${toolName}.`);
    }
  }

  return { entries, inverse, notes };
}

/**
 * Does this call CREATE a script (so its inverse is a delete) rather than EDIT one (inverse = rewrite)?
 * Decided from the ARGS, not from whether the read found anything: a dedicated create tool always
 * creates, and the real `multi_edit` creates when its first edit's `old_string` is empty (measured:
 * empty old_string is how the server writes a new script — a non-empty old_string that does not match
 * is a genuine edit that failed to read back, which must NOT be turned into a delete).
 */
function declaresCreate(toolName: string, args: unknown): boolean {
  const createsByName = toolName === 'studio.create_script' || toolName === 'create_script'
    || toolName === 'studio.write_script' || toolName === 'write_script';
  if (createsByName) return true;
  if (toolName !== 'studio.multi_edit' && toolName !== 'multi_edit') return false;
  const record = (args ?? {}) as Record<string, unknown>;
  const edits = Array.isArray(record.edits) ? (record.edits as Array<{ old_string?: string }>) : [];
  const first = edits[0];
  return first !== undefined && (first.old_string ?? '') === '';
}

/** A snapshot is restorable only when every touched target produced an inverse step. */
export function isRestorable(snapshot: PreStateSnapshot): boolean {
  return snapshot.inverse.length > 0 && snapshot.notes.length === 0;
}

/**
 * Re-read every target AFTER the mutation, so a later restore can tell "the turn wrote this" from
 * "a human edited it afterwards". Never throws: a failed read only weakens drift detection for that
 * target (it falls back to the pre-state comparison), it never fails the turn.
 */
export async function snapshotPostState(
  mcp: McpGateway,
  pre: PreStateSnapshot,
  signal?: AbortSignal,
): Promise<PostStateSnapshot> {
  const entries: PostStateEntry[] = [];
  const notes: string[] = [];
  for (const entry of pre.entries) {
    if (entry.kind === 'inserted') continue;
    if (entry.kind === 'script') {
      const source = await readScriptSource(mcp, entry.path, signal);
      if (source === null) {
        notes.push(`Không đọc lại được ${entry.path} sau khi sửa — lượt sau sẽ so với trạng thái trước đó.`);
        continue;
      }
      entries.push({ kind: 'script', path: entry.path, source });
      continue;
    }
    const bag = await inspectInstance(mcp, entry.path, signal);
    if (bag === null) {
      notes.push(`Không đọc lại được thuộc tính của ${entry.path} sau khi sửa.`);
      continue;
    }
    entries.push({ kind: 'properties', path: entry.path, properties: restorableProperties(bag) });
  }
  return { entries, notes };
}

