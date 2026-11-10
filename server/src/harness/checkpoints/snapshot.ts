import type { McpGateway } from '../tools/types';

/**
 * Pre-mutation snapshot — Phase 3 of `docs/superpowers/plans/morphi-git.md`.
 *
 * Phase 2 recorded *that* a mutation happened (`restorable: false`, "no pre-state"). This module
 * captures the pre-state so an inverse actually exists. The rule from the plan is absolute: a
 * checkpoint may only claim `restorable: true` when this module produced a snapshot whose restore
 * path is known; every other case keeps `restorable: false` with a reason a user can read.
 *
 * What can be snapshotted, and how:
 *  - **Script source** — `studio.script_read` (or `script_read`) with the script path. Gives the
 *    exact source text to write back.
 *  - **Instance properties** — `studio.inspect_instance` with the instance path. Gives a property
 *    bag to re-apply.
 *  - **Inserted asset / instance** — the inverse is a delete; the target id is in the args.
 *  - Everything else (arbitrary `execute_luau`, deleted instances with children) has no safe
 *    inverse from a read: those stay non-restorable instead of guessing.
 *
 * The snapshot is taken BEFORE the mutating call runs and is best-effort: a failed snapshot must
 * not block the user's tool call, it only downgrades the checkpoint to non-restorable.
 */

/** One thing the mutation can be undone from. */
export type SnapshotEntry =
  | { kind: 'script'; path: string; source: string }
  | { kind: 'properties'; path: string; properties: Record<string, unknown> }
  | { kind: 'inserted'; path: string };

export interface PreStateSnapshot {
  entries: SnapshotEntry[];
  /** Tools whose inverse is known for every target. Empty means "not restorable". */
  inverse: InverseStep[];
  /** Why a target could not be snapshotted, when some could not. */
  notes: string[];
}

export type InverseStep =
  | { tool: 'script_write'; path: string; source: string }
  | { tool: 'set_properties'; path: string; properties: Record<string, unknown> }
  | { tool: 'delete_instance'; path: string };

/** Tool names that write script source, in the order the snapshot prefers them. */
const SCRIPT_WRITE_TOOLS = ['studio.write_script', 'studio.edit_script', 'studio.create_script', 'studio.multi_edit'] as const;
/** Tool names whose inverse is "delete what was inserted". */
const INSERT_TOOLS = ['studio.insert_asset', 'studio.insert_instance'] as const;

/** Read tools the snapshot uses, in preference order. */
const SCRIPT_READ_TOOLS = ['studio.script_read', 'studio.read_script', 'script_read'] as const;
const INSPECT_TOOLS = ['studio.inspect_instance', 'inspect_instance'] as const;

const PATH_KEYS = ['path', 'script', 'target', 'targetPath', 'scriptPath', 'instancePath', 'filename'] as const;

function pathOf(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Every script path a `multi_edit` touches, plus its own path. */
function pathsOf(args: unknown): string[] {
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

/** The source text a write tool is about to put on disk, when the args carry it. */
function sourceOf(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of ['source', 'code', 'content', 'new_string', 'newText', 'script_content'] as const) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/** Pull a source string out of whatever shape a read tool answered with. */
function sourceFromReadResult(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (result === null || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of ['source', 'content', 'text', 'script', 'code'] as const) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  // Studio's MCP wraps content in a `content: [{ type: 'text', text }]` array.
  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part !== null && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') return text;
      }
    }
  }
  return null;
}

/** Pull a property bag out of an inspect answer. */
function propertiesFromInspect(result: unknown): Record<string, unknown> | null {
  if (result === null || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of ['properties', 'attributes', 'instance'] as const) {
    const value = record[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const bag = value as Record<string, unknown>;
      // `instance` may itself wrap `properties`.
      if (key === 'instance' && bag.properties !== null && typeof bag.properties === 'object') {
        return bag.properties as Record<string, unknown>;
      }
      return bag;
    }
  }
  return null;
}

/**
 * Call the first read tool the gateway actually exposes. Returns `undefined` when none is
 * available, which is the honest "cannot snapshot" answer — never a fabricated success.
 */
async function readWith(
  mcp: McpGateway,
  candidates: readonly string[],
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let available: Set<string>;
  try {
    available = new Set((await mcp.listTools()).map((tool) => tool.name));
  } catch {
    return undefined;
  }
  const tool = candidates.find((name) => available.has(name));
  if (tool === undefined) return undefined;
  try {
    return await mcp.callTool(tool, args, signal);
  } catch {
    return undefined;
  }
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
    const paths = pathsOf(args);
    if (paths.length === 0) {
      notes.push('Không đọc được đường dẫn script từ tham số của công cụ.');
    }
    for (const path of paths) {
      const read = await readWith(mcp, SCRIPT_READ_TOOLS, { path }, signal);
      const source = read === undefined ? null : sourceFromReadResult(read);
      if (source === null) {
        // A create has no old source by definition; its inverse is a delete, not a write.
        const created = toolName === 'studio.create_script' || toolName === 'studio.write_script';
        const about = sourceOf(args);
        if (created && about !== null) {
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
    // Property writes and arbitrary Luau have no read-back inverse we can trust.
    const path = pathOf(args);
    if (path !== null) {
      const inspected = await readWith(mcp, INSPECT_TOOLS, { path }, signal);
      const properties = inspected === undefined ? null : propertiesFromInspect(inspected);
      if (properties !== null) {
        entries.push({ kind: 'properties', path, properties });
        inverse.push({ tool: 'set_properties', path, properties });
      } else {
        notes.push(`Không có inverse an toàn cho ${toolName} trên ${path}.`);
      }
    } else {
      notes.push(`Không có inverse an toàn cho ${toolName}.`);
    }
  }

  return { entries, inverse, notes };
}

/** A snapshot is restorable only when every touched target produced an inverse step. */
export function isRestorable(snapshot: PreStateSnapshot): boolean {
  return snapshot.inverse.length > 0 && snapshot.notes.length === 0;
}
