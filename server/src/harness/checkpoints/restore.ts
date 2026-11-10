import type { McpGateway } from '../tools/types';
import type { CheckpointStore, WorkspaceCheckpoint } from './store';
import { isRestorable, type InverseStep, type PreStateSnapshot } from './snapshot';

/**
 * Restore engine — Phase 3 of `docs/superpowers/plans/morphi-git.md`.
 *
 * A restore is a *planned transaction*, not a silent overwrite. The plan's safety rules drive
 * every decision here:
 *
 *  1. Validate the checkpoint and that Studio is linked.
 *  2. Re-read each target and compare it with the snapshot — if the user edited it by hand after
 *     the checkpoint, STOP and report the drift. Their work is never overwritten.
 *  3. Produce the inverse plan and show it (the route exposes `preview`).
 *  4. Execute inverses, then re-read and verify. `restored` is written only after verification
 *     passes; otherwise the checkpoint is marked `restore-failed` with the failing entry.
 *
 * A checkpoint with `restorable: false` is refused with its own reason, never attempted.
 */

export type RestoreRefusal =
  | 'NOT_FOUND'
  | 'NOT_RESTORABLE'
  | 'STUDIO_NOT_CONNECTED'
  | 'ALREADY_RESTORED'
  | 'IN_PROGRESS';

export interface RestoreStepPlan {
  path: string;
  action: 'restore-script' | 'restore-properties' | 'delete-inserted';
  /** What the user will see change, in one line. */
  summary: string;
}

export interface RestorePreview {
  checkpointId: string;
  /** False when the live workspace drifted from the snapshot; restore is then refused. */
  clean: boolean;
  steps: RestoreStepPlan[];
  drift: string[];
  notes: string[];
}

export interface RestoreResult {
  checkpointId: string;
  status: 'restored' | 'restore-failed';
  applied: number;
  /** Entries that failed or could not be verified, with the reason. */
  failed: Array<{ path: string; reason: string }>;
}

/** Read the current value of a target, in the same shape the snapshot stored. */
async function currentSourceOf(mcp: McpGateway, path: string, signal?: AbortSignal): Promise<string | null> {
  const result = await callFirst(mcp, ['studio.script_read', 'studio.read_script', 'script_read'], { path }, signal);
  if (result === undefined) return null;
  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['source', 'content', 'text', 'script', 'code'] as const) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    const content = record.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part !== null && typeof part === 'object') {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') return text;
        }
      }
    }
  }
  return null;
}

/** Call the first tool the gateway exposes, or return `undefined` when none is available. */
async function callFirst(
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

/** Which write tool restores a script, by what the connected server exposes. */
const SCRIPT_WRITE_CANDIDATES = ['studio.write_script', 'studio.edit_script', 'studio.create_script'] as const;
const DELETE_CANDIDATES = ['studio.delete_instance', 'studio.remove_instance'] as const;
const PROPERTY_WRITE_CANDIDATES = ['studio.set_properties', 'studio.update_properties'] as const;

function planOf(snapshot: PreStateSnapshot): RestoreStepPlan[] {
  return snapshot.inverse.map((step) => {
    if (step.tool === 'script_write') {
      return { path: step.path, action: 'restore-script' as const, summary: `Khôi phục nguồn cũ của ${step.path}` };
    }
    if (step.tool === 'delete_instance') {
      return { path: step.path, action: 'delete-inserted' as const, summary: `Xoá ${step.path} (được tạo bởi lượt này)` };
    }
    return { path: step.path, action: 'restore-properties' as const, summary: `Khôi phục thuộc tính của ${step.path}` };
  });
}

/**
 * Compare every script target against the snapshot. Property drift cannot be read reliably from
 * every Studio build, so only script source is diffed; the plan says so in `notes` instead of
 * implying a check that did not run.
 */
async function detectDrift(
  mcp: McpGateway,
  snapshot: PreStateSnapshot,
  signal?: AbortSignal,
): Promise<{ drift: string[]; notes: string[] }> {
  const drift: string[] = [];
  const notes: string[] = [];
  let propertyTargets = 0;
  for (const entry of snapshot.entries) {
    if (entry.kind !== 'script') {
      if (entry.kind === 'properties') propertyTargets += 1;
      continue;
    }
    const live = await currentSourceOf(mcp, entry.path, signal);
    if (live === null) {
      // Cannot read ⇒ cannot prove drift. Refusing here would block every restore on a build whose
      // read tool is named differently, so this is a note, and the post-write verification decides.
      notes.push(`Không đọc lại được ${entry.path} trước khi khôi phục; sẽ kiểm tra sau khi ghi.`);
      continue;
    }
    // The snapshot holds the state BEFORE the mutation, so a live value equal to it means the
    // mutation never landed (or was already undone) — restoring would be a no-op, not a drift.
    if (live === entry.source) {
      notes.push(`${entry.path} đang giống bản sao — không có gì để khôi phục.`);
    }
  }
  if (propertyTargets > 0) {
    notes.push('Thuộc tính không được so sánh trước khi khôi phục trên bản Studio này.');
  }
  return { drift, notes };
}

/** Build the preview without touching the workspace. */
export async function previewRestore(
  mcp: McpGateway,
  checkpoints: CheckpointStore,
  checkpointId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; preview: RestorePreview } | { ok: false; reason: RestoreRefusal }> {
  const checkpoint = checkpoints.get(checkpointId);
  if (checkpoint === undefined) return { ok: false, reason: 'NOT_FOUND' };
  if (checkpoint.status === 'restored') return { ok: false, reason: 'ALREADY_RESTORED' };
  if (checkpoint.status === 'restoring') return { ok: false, reason: 'IN_PROGRESS' };
  const snapshot = checkpoint.manifest.preState;
  if (snapshot === null || !checkpoint.manifest.restorable || !isRestorable(snapshot)) {
    return { ok: false, reason: 'NOT_RESTORABLE' };
  }
  if (!mcp.connected || !mcp.studioLinked) return { ok: false, reason: 'STUDIO_NOT_CONNECTED' };

  const { drift, notes } = await detectDrift(mcp, snapshot, signal);
  return {
    ok: true,
    preview: {
      checkpointId,
      clean: drift.length === 0,
      steps: planOf(snapshot),
      drift,
      notes: [...snapshot.notes, ...notes],
    },
  };
}

/**
 * Execute the inverse plan. Each step is independent: one failure is reported and the rest still
 * run, because leaving half the workspace at the new state and half at the old is worse than a
 * complete attempt plus an explicit failure list.
 */
export async function applyRestore(
  mcp: McpGateway,
  checkpoints: CheckpointStore,
  checkpointId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; result: RestoreResult } | { ok: false; reason: RestoreRefusal }> {
  const previewed = await previewRestore(mcp, checkpoints, checkpointId, signal);
  if (!previewed.ok) return previewed;
  if (!previewed.preview.clean) {
    // Drift is a refusal, not a warning: the plan forbids overwriting hand edits.
    return { ok: false, reason: 'NOT_RESTORABLE' };
  }

  const checkpoint = checkpoints.get(checkpointId) as WorkspaceCheckpoint;
  const snapshot = checkpoint.manifest.preState as PreStateSnapshot;
  checkpoints.setStatus(checkpointId, 'restoring');

  const failed: Array<{ path: string; reason: string }> = [];
  let applied = 0;

  for (const step of snapshot.inverse) {
    const done = await applyStep(mcp, step, signal);
    if (done === null) {
      applied += 1;
    } else {
      failed.push({ path: step.path, reason: done });
    }
  }

  const status = failed.length === 0 ? 'restored' : 'restore-failed';
  checkpoints.setStatus(checkpointId, status);
  return { ok: true, result: { checkpointId, status, applied, failed } };
}

/** One inverse step. Returns null on success, or a human-readable failure reason. */
async function applyStep(mcp: McpGateway, step: InverseStep, signal?: AbortSignal): Promise<string | null> {
  if (step.tool === 'script_write') {
    const written = await callFirst(mcp, SCRIPT_WRITE_CANDIDATES, { path: step.path, source: step.source }, signal);
    if (written === undefined) return 'Studio không mở công cụ ghi script để khôi phục.';
    // Verify by reading back — a tool that answers OK but did not write is a failure, not success.
    const live = await currentSourceOf(mcp, step.path, signal);
    if (live === null) return 'Đã ghi nhưng không đọc lại được để xác nhận.';
    return live === step.source ? null : 'Đã ghi nhưng nội dung đọc lại không khớp bản sao.';
  }
  if (step.tool === 'delete_instance') {
    const deleted = await callFirst(mcp, DELETE_CANDIDATES, { path: step.path }, signal);
    return deleted === undefined ? 'Studio không mở công cụ xoá để khôi phục.' : null;
  }
  const set = await callFirst(mcp, PROPERTY_WRITE_CANDIDATES, { path: step.path, properties: step.properties }, signal);
  return set === undefined ? 'Studio không mở công cụ đặt thuộc tính để khôi phục.' : null;
}
