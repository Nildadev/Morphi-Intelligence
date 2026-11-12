import type { McpGateway } from '../tools/types';
import type { CheckpointStore, WorkspaceCheckpoint } from './store';
import { isRestorable, type PostStateEntry, type PostStateSnapshot, type PreStateSnapshot } from './snapshot';
import {
  captureCframe,
  captureIdentity,
  deleteInstance,
  inspectInstance,
  instanceExists,
  isCframeMarkerValue,
  isNameValue,
  isParentValue,
  readScriptSource,
  recreateInstance,
  sameCframe,
  setInstanceProperties,
  sameIdentity,
  samePivot,
  writeScriptSource,
  type CapturedCframe,
  type CapturedIdentity,
  type CframeValue,
  type InverseStep,
  type PropertyWriteResult,
  type RecreateResult,
} from './studioWire';

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
  action: 'restore-script' | 'restore-properties' | 'delete-inserted' | 'recreate-deleted';
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
  /**
   * Individual properties this Studio build refused to write, in its own words. Not a failure: the
   * rest of the restore landed and was verified. Surfaced so the user learns that e.g. `BrickColor`
   * could not be put back instead of believing the whole instance was restored.
   */
  skipped: RestoreSkipped[];
}

export interface RestoreSkipped {
  path: string;
  key: string;
  reason: string;
}

/** Read the current value of a target, in the same shape the snapshot stored. */
async function currentSourceOf(mcp: McpGateway, path: string, signal?: AbortSignal): Promise<string | null> {
  return readScriptSource(mcp, path, signal);
}

/** The human-readable inverse plan, derived from the snapshot's own steps. */
function planOf(snapshot: PreStateSnapshot): RestoreStepPlan[] {
  return snapshot.inverse.map((step) => {
    if (step.tool === 'script_write') {
      return { path: step.path, action: 'restore-script' as const, summary: `Khôi phục nguồn cũ của ${step.path}` };
    }
    if (step.tool === 'delete_instance') {
      return { path: step.path, action: 'delete-inserted' as const, summary: `Xoá ${step.path} (được tạo bởi lượt này)` };
    }
    if (step.tool === 'recreate_instance') {
      return { path: step.path, action: 'recreate-deleted' as const, summary: `Tạo lại ${step.path} (bị lượt này xoá)` };
    }
    return { path: step.path, action: 'restore-properties' as const, summary: `Khôi phục thuộc tính của ${step.path}` };
  });
}

/**
 * Compare every target with what the TURN wrote (`postState`). Script source is diffed exactly; a
 * property target is diffed by re-inspecting the instance and comparing the keys the turn touched.
 * When the property bag cannot be read, that is a note — never a silent "checked".
 *
 * Why post-state and not pre-state: after a successful mutation the live workspace legitimately
 * differs from the pre-state, so a pre-state-only comparison cannot tell the turn's own write from a
 * later hand edit — measured live, a script hand-edited to `local V = 99` after a turn that wrote
 * `local V = 2` previewed as clean and the undo overwrote it. The three cases are now distinct:
 *   live == post ⇒ the turn's write, invert it;
 *   live == pre  ⇒ already back at the old state, a no-op note;
 *   neither      ⇒ edited after the turn ⇒ drift (refuse).
 * Checkpoints recorded before post-state capture existed have `postState: null` and keep the old
 * pre-state behaviour, so history stays restorable instead of becoming permanently refused.
 */
async function detectDrift(
  mcp: McpGateway,
  snapshot: PreStateSnapshot,
  signal?: AbortSignal,
  strict = false,
  postState?: PostStateSnapshot | null,
): Promise<{ drift: string[]; notes: string[] }> {
  const drift: string[] = [];
  const notes: string[] = [];
  const postOf = (path: string): PostStateEntry | undefined =>
    postState?.entries.find((entry) => entry.path === path);
  /**
   * The post-state entry for a snapshot path, following a MOVE.
   *
   * A turn that renames or reparents an instance makes its snapshot path stop resolving, so the entry
   * is recorded at the path the instance was found at afterwards, with `fromPath` naming the original
   * (see `snapshotPostState`). Without following it, the undo of a rename would refuse its own change.
   */
  const postFor = (path: string): PostStateEntry | undefined =>
    postOf(path)
    ?? postState?.entries.find((entry) => entry.kind === 'properties' && entry.fromPath === path);
  for (const entry of snapshot.entries) {
    if (entry.kind === 'inserted') continue;
    if (entry.kind === 'properties') {
      const post = postFor(entry.path);
      // The instance may have MOVED: a rename or a reparent is the turn's own doing, so the snapshot
      // path is gone by design and the live reads happen where the post-state found it.
      const livePath = post !== undefined && post.kind === 'properties' ? post.path : entry.path;
      const live = await inspectInstance(mcp, livePath, signal);
      if (live === null) {
        // The official server returns the bag from `inspect_instance`; if that failed we cannot
        // prove the instance is safe to overwrite, which is drift for a batch (turn) restore.
        if (strict) drift.push(`${entry.path} không đọc lại được thuộc tính — không xác nhận được trạng thái hiện tại.`);
        else notes.push(`Không đọc lại được thuộc tính của ${entry.path}; sẽ kiểm tra sau khi ghi.`);
        continue;
      }
      // The name, the parent and the transform are not in the bag under their own keys, so they cannot
      // be compared like the scalars: they are read back once with `captureIdentity` and diffed. Without
      // this, a renamed/reparented/moved instance would read as drift (undefined vs marker) and its own
      // undo would be refused.
      const identityDiff = (markers: Record<string, unknown>, live: CapturedIdentity | null): string[] => {
        const differing: string[] = [];
        for (const key of IDENTITY_KEYS) {
          const marker = markers[key];
          if (marker === undefined) continue;
          if (live === null) {
            differing.push(key);
            continue;
          }
          if (key === 'Name' || key === 'Parent') {
            if (!sameIdentity(markers.Name, markers.Parent, live)) differing.push(key);
            continue;
          }
          // A PivotOffset is an OFFSET measured against the transform: comparing it with the CFrame
          // would report every part as drifted, and comparing the CFrame with it would hide a moved
          // pivot. Each marker is diffed against its own capture.
          if (key === 'PivotOffset') {
            if (!samePivot(marker, live)) differing.push(key);
            continue;
          }
          if (!sameCframe(marker as CframeValue, live.cframe)) differing.push(key);
        }
        return differing;
      };
      const hasIdentity = IDENTITY_KEYS.some((key) => key in entry.properties)
        || (post !== undefined && post.kind === 'properties' && IDENTITY_KEYS.some((key) => key in post.properties));
      if (hasIdentity) {
        // Three cases, exactly like the scalars below: live == post means the turn's own value, invert
        // it; live == pre means already restored, a no-op; anything else was changed by hand, and
        // overwriting that is what the plan forbids.
        const live = await captureIdentity(mcp, livePath, signal);
        const postMarkers = post !== undefined && post.kind === 'properties' ? post.properties : undefined;
        const atPre = identityDiff(entry.properties, live).length === 0;
        const atPost = postMarkers !== undefined && identityDiff(postMarkers, live).length === 0;
        const clean = postMarkers === undefined ? !atPre : atPost;
        if (!clean) {
          if (atPre) {
            notes.push(`${entry.path} đang mang đúng tên/vị trí cũ — không có gì để khôi phục.`);
          } else {
            const message = `${entry.path} đã bị đổi tên, chuyển chỗ hoặc di chuyển tay sau lượt này — không ghi đè lên thay đổi đó.`;
            if (strict) drift.push(message);
            else notes.push(message);
          }
          continue;
        }
      }

      const changedSincePost = post !== undefined && post.kind === 'properties'
        ? scalarKeys({ ...entry.properties, ...post.properties })
          .filter((key) => !sameValue(live[key], post.properties[key]))
        : [];
      if (changedSincePost.length > 0) {
        // The instance no longer holds what the turn wrote: a hand edit landed afterwards, and
        // restoring would overwrite it.
        const message = `${entry.path} đã bị sửa tay sau lượt này (${changedSincePost.join(', ')}).`;
        if (strict) drift.push(message);
        else notes.push(message);
        continue;
      }
      if (post !== undefined) continue;
      // No post-state (an older checkpoint): fall back to the pre-state comparison.
      const changed = scalarKeys(entry.properties)
        .filter((key) => !sameValue(live[key], entry.properties[key]));
      if (changed.length > 0) {
        // The property still holds what the turn wrote, not what the snapshot recorded: restoring
        // would overwrite a hand edit, so the plan refuses.
        if (strict) drift.push(`${entry.path} đã đổi thuộc tính (${changed.join(', ')}) kể từ bản sao.`);
        else notes.push(`${entry.path} có thuộc tính khác bản sao (${changed.join(', ')}).`);
      }
      continue;
    }
    if (entry.kind === 'deleted') {
      // The turn deleted this instance. "Nothing to do" and "do not touch it" are the same answer
      // here: if anything occupies the path now, recreating over it would overwrite live work, so
      // the undo stands down and says why instead of guessing what the path holds.
      const exists = await instanceExists(mcp, entry.path, signal);
      if (exists === null) {
        // A failed probe is NOT "gone": recreating on that assumption is exactly the overwrite the
        // plan forbids, so this refuses in both modes rather than degrade to a note.
        drift.push(`${entry.path} không kiểm tra được — không xác nhận được là đã bị xoá.`);
        continue;
      }
      if (exists) {
        notes.push(`${entry.path} đang tồn tại — không tạo lại để tránh ghi đè.`);
      }
      continue;
    }
    const live = await currentSourceOf(mcp, entry.path, signal);
    if (live === null) {
      // Cannot read ⇒ cannot prove the target is safe to overwrite. A single-checkpoint restore
      // lets the post-write verification decide, but a TURN-level undo is a batch: one unverifiable
      // target would leave the turn half restored, so `strict` refuses the whole thing instead.
      if (strict) drift.push(`${entry.path} không đọc lại được — không xác nhận được trạng thái hiện tại.`);
      else notes.push(`Không đọc lại được ${entry.path} trước khi khôi phục; sẽ kiểm tra sau khi ghi.`);
      continue;
    }
    const post = postOf(entry.path);
    if (post !== undefined && post.kind === 'script') {
      // The live source is exactly what the turn wrote: the normal, clean case.
      if (live === post.source) continue;
      // Already back at the old source (never landed, or undone): writing it again is a no-op.
      if (live === entry.source) {
        notes.push(`${entry.path} đang giống bản sao — không có gì để khôi phục.`);
        continue;
      }
      const message = `${entry.path} đã bị sửa tay sau lượt này — không ghi đè lên thay đổi đó.`;
      if (strict) drift.push(message);
      else notes.push(message);
      continue;
    }
    // No post-state (an older checkpoint): a live value equal to the pre-state means the mutation
    // never landed (or was already undone) — restoring would be a no-op, not a drift.
    if (live === entry.source) {
      notes.push(`${entry.path} đang giống bản sao — không có gì để khôi phục.`);
    }
  }
  return { drift, notes };
}

/** Keys whose value is captured outside the bag (see `identityMarkers`). */
const IDENTITY_KEYS = ['Name', 'Parent', 'CFrame', 'WorldPivot', 'PivotOffset'] as const;

/** Keys excluded from the scalar comparison, because they are markers handled above. */
function scalarKeys(source: Record<string, unknown>): string[] {
  return Object.keys(source).filter(
    (key) => !key.includes('.') && !(IDENTITY_KEYS as readonly string[]).includes(key),
  );
}
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) < 1e-9;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  return false;
}

/** Build the preview without touching the workspace. */
export async function previewRestore(
  mcp: McpGateway,
  checkpoints: CheckpointStore,
  checkpointId: string,
  signal?: AbortSignal,
  /** Turn-level undo: an unreadable target is drift, because the batch must not half-apply. */
  strict = false,
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

  const { drift, notes } = await detectDrift(mcp, snapshot, signal, strict, checkpoint.manifest.postState ?? null);
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
  /** Turn-level undo: pass true so an unreadable target refuses before any write. */
  strict = false,
): Promise<{ ok: true; result: RestoreResult } | { ok: false; reason: RestoreRefusal }> {
  const previewed = await previewRestore(mcp, checkpoints, checkpointId, signal, strict);
  if (!previewed.ok) return previewed;
  if (!previewed.preview.clean) {
    // Drift is a refusal, not a warning: the plan forbids overwriting hand edits.
    return { ok: false, reason: 'NOT_RESTORABLE' };
  }

  const checkpoint = checkpoints.get(checkpointId) as WorkspaceCheckpoint;
  const snapshot = checkpoint.manifest.preState as PreStateSnapshot;
  checkpoints.setStatus(checkpointId, 'restoring');

  const failed: Array<{ path: string; reason: string }> = [];
  const skipped: RestoreSkipped[] = [];
  let applied = 0;

  for (const step of snapshot.inverse) {
    const done = await applyStep(mcp, redirectStep(step, checkpoint.manifest.postState ?? null), signal, skipped);
    if (done === null) {
      applied += 1;
    } else {
      failed.push({ path: step.path, reason: done });
    }
  }

  const status = failed.length === 0 ? 'restored' : 'restore-failed';
  checkpoints.setStatus(checkpointId, status);
  return { ok: true, result: { checkpointId, status, applied, failed, skipped } };
}

/**
 * Where the instance will live once the recorded identity is applied, or null when the snapshot carries
 * no name/parent marker (nothing will move it).
 */
function identityPathOf(properties: Record<string, unknown>): string | null {
  const name = properties.Name;
  const parent = properties.Parent;
  if (!isNameValue(name) || !isParentValue(parent)) return null;
  return `${parent.$parent}.${name.$name}`;
}

/**
 * Point a property step at where the instance IS now.
 *
 * A rename or a reparent is applied back by writing `Name`/`Parent` markers, but those writes have to
 * reach the instance at its current path — the snapshot path stopped resolving when the turn moved it.
 * Only that one shape is redirected: a script cannot move, and a delete/recreate targets a path whose
 * meaning is the path itself.
 */
function redirectStep(step: InverseStep, postState: PostStateSnapshot | null): InverseStep {
  if (step.tool !== 'set_properties' || postState === null) return step;
  const moved = postState.entries.find(
    (entry) => entry.kind === 'properties' && entry.fromPath === step.path,
  );
  if (moved === undefined || moved.kind !== 'properties') return step;
  return { ...step, path: moved.path };
}

/** One inverse step. Returns null on success, or a human-readable failure reason. */
async function applyStep(
  mcp: McpGateway,
  step: InverseStep,
  signal?: AbortSignal,
  /** Per-property refusals are collected here so the caller can report them without failing. */
  skipped: RestoreSkipped[] = [],
): Promise<string | null> {
  if (step.tool === 'script_write') {
    try {
      await writeScriptSource(mcp, step.path, step.source, signal);
    } catch (error) {
      return error instanceof Error ? error.message : 'Studio không mở công cụ ghi script để khôi phục.';
    }
    // Verify by reading back — a tool that answers OK but did not write is a failure, not success.
    const live = await currentSourceOf(mcp, step.path, signal);
    if (live === null) return 'Đã ghi nhưng không đọc lại được để xác nhận.';
    return live === step.source ? null : 'Đã ghi nhưng nội dung đọc lại không khớp bản sao.';
  }
  if (step.tool === 'delete_instance') {
    // Something the turn created may have been removed by hand since. Deleting it again would be a
    // failure reported against a workspace that is already correct; a probe that FAILED (null) is not
    // "already gone", so only a definite false is treated as a no-op.
    const exists = await instanceExists(mcp, step.path, signal);
    if (exists === false) return null;
    try {
      const deleted = await deleteInstance(mcp, step.path, signal);
      return deleted ? null : 'Studio báo xoá thất bại.';
    } catch (error) {
      return error instanceof Error ? error.message : 'Studio không mở công cụ xoá để khôi phục.';
    }
  }
  if (step.tool === 'recreate_instance') {
    let recreated: RecreateResult;
    try {
      recreated = await recreateInstance(mcp, step.path, step.tree, signal);
    } catch (error) {
      return error instanceof Error ? error.message : 'Studio không mở công cụ Luau để tạo lại.';
    }
    for (const entry of recreated.skipped) skipped.push({ path: entry.path, key: entry.key, reason: entry.reason });
    // Same anti-lie rule as the other steps: the root must actually be there afterwards.
    if (!recreated.created.includes(step.path)) return 'Không tạo lại được đối tượng gốc.';
    const exists = await instanceExists(mcp, step.path, signal);
    if (exists === null) return 'Đã tạo lại nhưng không đọc lại được để xác nhận.';
    return exists ? null : 'Đã tạo lại nhưng đối tượng không còn ở đó.';
  }
  let written: PropertyWriteResult;
  try {
    written = await setInstanceProperties(mcp, step.path, step.properties, signal);
  } catch (error) {
    return error instanceof Error ? error.message : 'Studio không mở công cụ đặt thuộc tính để khôi phục.';
  }
  for (const entry of written.skipped) skipped.push({ path: step.path, key: entry.key, reason: entry.reason });
  // Nothing went in: there is nothing to verify, and the skipped list carries the whole story.
  if (written.applied.length === 0) return null;

  // Same anti-lie rule as scripts: re-inspect and require the recorded values back. Only the keys the
  // server claims it assigned are checked — a refused key is reported, not counted as a mismatch.
  //
  // Read back where the instance is AFTER the write, not where it was before it: restoring a Name or a
  // Parent moves it, and a verification at the old path would report "could not read" for a restore
  // that actually landed (measured live on the rename scenario).
  const finalPath = identityPathOf(step.properties) ?? step.path;
  const live = await inspectInstance(mcp, finalPath, signal);
  if (live === null) return `Đã đặt thuộc tính nhưng không đọc lại được ${finalPath} để xác nhận.`;
  const mismatched: string[] = [];
  let identity: CapturedIdentity | null | undefined;
  const liveIdentity = async (): Promise<CapturedIdentity | null> => {
    identity ??= await captureIdentity(mcp, finalPath, signal);
    return identity;
  };
  for (const key of written.applied) {
    const before = step.properties[key];
    if (key === 'PivotOffset') {
      // Same $cframe marker shape as the transform, so this has to come FIRST — read against the CFrame
      // it would report a false mismatch for every part that has a pivot offset.
      if (!samePivot(before, await liveIdentity())) mismatched.push(key);
      continue;
    }
    if (isCframeMarkerValue(before)) {
      // A transform has no bag entry of its own: compare the matrix, not `live['CFrame']`.
      const after = (await liveIdentity())?.cframe ?? null;
      if (!sameCframe(before, after)) mismatched.push(key);
      continue;
    }
    if (key === 'Name' || key === 'Parent') {
      // The bags carry neither, so the read-back is the identity capture.
      if (!sameIdentity(step.properties.Name, step.properties.Parent, await liveIdentity())) mismatched.push(key);
      continue;
    }
    if (!sameValue(live[key], before)) mismatched.push(key);
  }
  return mismatched.length === 0 ? null : `Thuộc tính đọc lại không khớp bản sao (${mismatched.join(', ')}).`;
}

/**
 * Turn-level undo — the "Undo" button on the end-of-message script summary.
 *
 * A turn is one user-visible change, but it can hold several mutating calls. Undoing it means
 * restoring every restorable checkpoint whose `callId` belongs to that turn, and it must behave
 * like ONE transaction at the decision boundary: if any of them drifted, nothing is written.
 * Half-restoring a turn would leave the workspace in a state that matches neither the old nor the
 * new code, which is worse than refusing.
 *
 * Checkpoints that never had a snapshot are reported separately (`notRestorable`) rather than
 * silently skipped: the user asked to undo the turn, so they must learn which scripts cannot be
 * put back.
 */
export interface TurnRestoreResult {
  /** Checkpoint ids that were restored and verified. */
  restored: string[];
  /** Per-target failures from the checkpoints that were attempted. */
  failed: Array<{ path: string; reason: string }>;
  /** Individual properties this build refused, with Studio's own message. */
  skipped: RestoreSkipped[];
  /** Checkpoints in this turn that had no snapshot; `reason` is the server's own sentence. */
  notRestorable: Array<{ checkpointId: string; reason: string }>;
  /** Script paths whose live content no longer matches the snapshot. Non-empty ⇒ nothing written. */
  drift: string[];
  status: 'restored' | 'restore-failed' | 'refused';
}

export type TurnRestoreRefusal = 'NOTHING_TO_RESTORE' | 'STUDIO_NOT_CONNECTED' | 'IN_PROGRESS';

export async function restoreTurn(
  mcp: McpGateway,
  checkpoints: CheckpointStore,
  sessionId: string,
  callIds: readonly string[],
  signal?: AbortSignal,
): Promise<{ ok: true; result: TurnRestoreResult } | { ok: false; reason: TurnRestoreRefusal }> {
  const wanted = new Set(callIds);
  const rows = checkpoints.list(sessionId).filter((row) => wanted.has(row.manifest.callId));
  if (rows.length === 0) return { ok: false, reason: 'NOTHING_TO_RESTORE' };

  const notRestorable = rows
    .filter((row) => !row.manifest.restorable || row.manifest.preState === null)
    .map((row) => ({ checkpointId: row.id, reason: row.manifest.restoreReason }));

  // Already-restored rows are not failures; they simply have nothing left to do.
  const candidates = rows.filter((row) =>
    row.manifest.restorable
    && row.manifest.preState !== null
    && row.status !== 'restored'
    && row.status !== 'restoring');

  if (candidates.length === 0) {
    return {
      ok: true,
      result: { restored: [], failed: [], skipped: [], notRestorable, drift: [], status: 'refused' },
    };
  }
  if (!mcp.connected || !mcp.studioLinked) return { ok: false, reason: 'STUDIO_NOT_CONNECTED' };

  // Preview EVERY candidate before writing anything: one dirty target refuses the whole turn.
  const drift: string[] = [];
  for (const row of candidates) {
    const previewed = await previewRestore(mcp, checkpoints, row.id, signal, true);
    if (!previewed.ok) {
      if (previewed.reason === 'IN_PROGRESS') return { ok: false, reason: 'IN_PROGRESS' };
      notRestorable.push({ checkpointId: row.id, reason: previewed.reason });
      continue;
    }
    drift.push(...previewed.preview.drift);
  }
  if (drift.length > 0) {
    return {
      ok: true,
      result: { restored: [], failed: [], skipped: [], notRestorable, drift, status: 'refused' },
    };
  }

  const restored: string[] = [];
  const failed: TurnRestoreResult['failed'] = [];
  const skipped: RestoreSkipped[] = [];
  for (const row of candidates) {
    const applied = await applyRestore(mcp, checkpoints, row.id, signal, true);
    if (!applied.ok) {
      failed.push({ path: row.manifest.targets[0] ?? row.id, reason: applied.reason });
      continue;
    }
    skipped.push(...applied.result.skipped);
    if (applied.result.status === 'restored') restored.push(row.id);
    else failed.push(...applied.result.failed);
  }

  return {
    ok: true,
    result: {
      restored,
      failed,
      skipped,
      notRestorable,
      drift: [],
      status: failed.length === 0 ? 'restored' : 'restore-failed',
    },
  };
}
