import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PostStateSnapshot, PreStateSnapshot } from './snapshot';

/**
 * Phase 2 of `docs/superpowers/plans/morphi-git.md`: an immutable audit record for one
 * mutating Studio tool call. The manifest is content-addressed (`root_hash`) so a
 * history browser can show what ran, with what arguments, and whether an inverse is
 * known. `restorable` stays false until a real pre-state snapshot exists — the
 * system never claims a tool side effect was undone when the inverse is unknown.
 */
export interface CheckpointManifest {
  tool: string;
  callId: string;
  argsHash: string;
  /** Best-effort target identifiers extracted from the call arguments. */
  targets: string[];
  outcome: 'ok' | 'error' | 'cancelled' | 'denied';
  /**
   * Phase 3: what the targets looked like BEFORE the mutation, when a read could capture them.
   * `null` means no snapshot was taken; the checkpoint is then an audit record only.
   */
  preState: PreStateSnapshot | null;
  /**
   * Phase 5: what the turn itself wrote, per target (null when it could not be read, and absent on
   * checkpoints recorded before post-state capture existed). Drift compares the live workspace with
   * THIS, so a hand edit made after the turn is refused instead of silently overwritten.
   */
  postState?: PostStateSnapshot | null;
  /**
   * True only when every touched target produced a known inverse step (see `snapshot.ts`).
   * The plan's safety rule: never claim undoability that is not backed by a snapshot.
   */
  restorable: boolean;
  restoreReason: string;
}

export interface WorkspaceCheckpoint {
  id: string;
  sessionId: string;
  createdAt: number;
  label: string | null;
  baseEventSeq: number | null;
  rootHash: string;
  manifest: CheckpointManifest;
  status: CheckpointStatus;
}

/** Lifecycle of a checkpoint. Only `restored` means the workspace was put back. */
export type CheckpointStatus = 'recorded' | 'restoring' | 'restored' | 'restore-failed';

export interface RecordCheckpointInput {
  sessionId: string;
  label?: string | null;
  baseEventSeq?: number | null;
  manifest: CheckpointManifest;
}

const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex');

export class CheckpointStore {
  constructor(private db: Database.Database) {}

  record(input: RecordCheckpointInput): WorkspaceCheckpoint {
    const manifestJson = JSON.stringify(input.manifest);
    const row = {
      id: `ckp_${randomUUID()}`,
      session_id: input.sessionId,
      created_at: Date.now(),
      label: input.label ?? null,
      base_event_seq: input.baseEventSeq ?? null,
      root_hash: hashOf(manifestJson),
      manifest: manifestJson,
      status: 'recorded',
    };
    this.db.prepare(
      'INSERT INTO workspace_checkpoints (id, session_id, created_at, label, base_event_seq, root_hash, manifest, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.session_id, row.created_at, row.label, row.base_event_seq, row.root_hash, row.manifest, row.status);
    return this.get(row.id)!;
  }

  list(sessionId: string): WorkspaceCheckpoint[] {
    const rows = this.db.prepare(
      'SELECT id, session_id, created_at, label, base_event_seq, root_hash, manifest, status FROM workspace_checkpoints WHERE session_id = ? ORDER BY created_at DESC, rowid DESC',
    ).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toCheckpoint);
  }

  get(id: string): WorkspaceCheckpoint | undefined {
    const row = this.db.prepare(
      'SELECT id, session_id, created_at, label, base_event_seq, root_hash, manifest, status FROM workspace_checkpoints WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? toCheckpoint(row) : undefined;
  }

  /**
   * Phase 3: status transitions are one-way and explicit — `recorded` → `restoring` →
   * `restored` | `restore-failed`. A checkpoint is never marked `restored` optimistically; the
   * restore engine calls this only after re-reading the target and seeing the old state back.
   */
  setStatus(id: string, status: CheckpointStatus): void {
    this.db.prepare('UPDATE workspace_checkpoints SET status = ? WHERE id = ?').run(status, id);
  }
}

function toCheckpoint(row: Record<string, unknown>): WorkspaceCheckpoint {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    createdAt: row.created_at as number,
    label: (row.label as string | null) ?? null,
    baseEventSeq: (row.base_event_seq as number | null) ?? null,
    rootHash: row.root_hash as string,
    manifest: JSON.parse(row.manifest as string) as CheckpointManifest,
    status: row.status as CheckpointStatus,
  };
}

/** Hash a tool-call argument bag for auditability without storing raw secrets. */
export function hashArgs(args: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? '';
  } catch {
    serialized = String(args);
  }
  return hashOf(serialized);
}

const TARGET_KEYS = new Set(['path', 'target', 'targetPath', 'scriptPath', 'instancePath', 'name', 'id']);

/** Best-effort extraction of Studio target identifiers from args (strings only). */
export function extractTargets(args: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.includes('/') && value.length <= 260) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (TARGET_KEYS.has(key) && typeof item === 'string' && item.length > 0) found.add(item);
        else visit(item, depth + 1);
      }
    }
  };
  visit(args, 0);
  return [...found].slice(0, 20);
}
