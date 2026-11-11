import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { applyRestore, previewRestore, restoreTurn } from '../harness/checkpoints/restore';
import { createId } from '../harness/shared/id';
import { setPlanMode } from '../harness/plan/mode';
import { SubagentBusyError, SubagentDepthError } from '../harness/subagents';
import { api, HttpError, parseWith, pathParam } from '../http/validation';

const listSchema = z.strictObject({ projectId: z.string().trim().min(1).optional() });
const replaySchema = z.strictObject({ after: z.coerce.number().int().min(0).optional() });
const createSessionSchema = z.strictObject({
  projectId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(160).optional(),
});
const pinSchema = z.strictObject({ pinned: z.boolean().optional() });
const branchSchema = z.strictObject({ toSeq: z.number().int().min(0).optional() });
const undoMessageSchema = z.strictObject({ messageId: z.string().trim().min(1).max(120) });
/** Turn-level undo: the call ids the summary counted. Capped so one request cannot scan the log. */
const undoTurnSchema = z.strictObject({
  callIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
});
const goalSchema = z.strictObject({ objective: z.string().trim().min(1).max(2000) });
const subagentSchema = z.strictObject({ task: z.string().trim().min(1).max(8000) });

/** Placeholder until `TitleService` names the session from its first message (Task 18). */
export const DEFAULT_TITLE = 'Cuộc trò chuyện mới';

/** Existence, not the projection: these routes only need the 404, never the derived messages. */
function requireSession(harness: Harness, id: string): void {
  if (!harness.sessions.exists(id)) throw new HttpError(404, 'SESSION_NOT_FOUND');
}

/** Every session route reads the same `:id` segment; narrow it once instead of at each call site. */
function sessionIdOf(req: Request): string {
  return pathParam(req.params.id, 'id');
}

export function createSessionsRouter(harness: Harness): Router {
  const router = Router();
  // The harness owns the subagent runner: route spawns and the model-facing `subagent` tool
  // must share its concurrency/depth bookkeeping.
  const subagents = harness.subagents;

  router.get('/', api((req, res) => {
    const query = parseWith(listSchema, req.query, 'query');
    // Summaries only: the rail must never pull a session's whole event log to render a row.
    // Visible only: a session with no user/assistant message yet stays out of the list.
    res.json(harness.sessions.listVisible(query.projectId));
  }));

  router.post('/', api((req, res) => {
    const input = parseWith(createSessionSchema, req.body, 'body');
    // Direct row lookup: `projects.list().some()` would read and project every project on the busiest
    // write in the app.
    if (!harness.projects.get(input.projectId)) {
      throw new HttpError(404, 'PROJECT_NOT_FOUND');
    }
    const created = harness.sessions.create(input.projectId, input.title ?? DEFAULT_TITLE, input.model);
    // Re-read the row instead of echoing the store's hand-built object: the join supplies
    // `projectName`, so POST and GET answer with one shape and Task 19 does not have to re-fetch a
    // session it just created to render its own row.
    res.status(201).json(harness.sessions.get(created.id) ?? created);
  }));

  router.get('/:id', api((req, res) => {
    const detail = harness.sessions.get(sessionIdOf(req));
    if (!detail) throw new HttpError(404, 'SESSION_NOT_FOUND');
    res.json(detail);
  }));

  router.get('/:id/events', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const { after = 0 } = parseWith(replaySchema, req.query, 'query');
    const events = harness.events.list(id, after);
    res.json({ sessionId: id, events, lastSeq: events[events.length - 1]?.seq ?? after });
  }));

  // Git-like history (Phase 2): the Studio checkpoints recorded for this session, newest first.
  router.get('/:id/checkpoints', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    res.json(harness.checkpoints.list(id));
  }));

  /**
   * Phase 3 — restore preview. Read-only: it re-reads the live workspace to report drift and the
   * exact inverse steps, so the user sees the plan before anything is written. A checkpoint that
   * cannot be restored answers 409 with the reason instead of pretending.
   */
  router.get('/:id/checkpoints/:checkpointId/restore', api(async (req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const checkpointId = pathParam(req.params.checkpointId, 'checkpointId');
    const checkpoint = harness.checkpoints.get(checkpointId);
    if (checkpoint === undefined || checkpoint.sessionId !== id) throw new HttpError(404, 'CHECKPOINT_NOT_FOUND');
    const previewed = await previewRestore(harness.mcp, harness.checkpoints, checkpointId);
    if (!previewed.ok) throw new HttpError(409, previewed.reason);
    res.json(previewed.preview);
  }));

  /**
   * Phase 3 — execute the restore. The engine refuses when the preview found drift, so a hand edit
   * made after the checkpoint is never overwritten. The checkpoint reaches `restored` only after the
   * write was read back and verified.
   */
  router.post('/:id/checkpoints/:checkpointId/restore', api(async (req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const checkpointId = pathParam(req.params.checkpointId, 'checkpointId');
    const checkpoint = harness.checkpoints.get(checkpointId);
    if (checkpoint === undefined || checkpoint.sessionId !== id) throw new HttpError(404, 'CHECKPOINT_NOT_FOUND');
    const restored = await applyRestore(harness.mcp, harness.checkpoints, checkpointId);
    if (!restored.ok) throw new HttpError(409, restored.reason);
    res.json(restored.result);
  }));

  /**
   * Turn-level undo — the "Hoàn tác" button on the end-of-message script summary.
   *
   * One turn can hold several mutating calls, so this is a batch: every restorable checkpoint whose
   * `callId` is in the body is restored, and the batch behaves like one transaction at the decision
   * boundary — a drifted target refuses the WHOLE turn instead of leaving half of it old and half
   * new. Checkpoints with no snapshot come back in `notRestorable` with the server's own reason,
   * so the UI can say which scripts could not be put back rather than implying full success.
   */
  router.post('/:id/undo-turn', api(async (req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const { callIds } = parseWith(undoTurnSchema, req.body ?? {}, 'body');
    const result = await restoreTurn(harness.mcp, harness.checkpoints, id, callIds);
    if (!result.ok) throw new HttpError(409, result.reason);
    res.json(result.result);
  }));

  router.post('/:id/pin', api((req, res) => {
    const id = sessionIdOf(req);
    // Pinning answers "toggle it" when no flag was sent, so this route genuinely needs the stored
    // row: one read, instead of an existence probe plus a second projection.
    const current = harness.sessions.get(id);
    if (!current) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const { pinned } = parseWith(pinSchema, req.body ?? {}, 'body');
    const next = pinned ?? !current.isPinned;
    harness.sessions.setPinned(id, next);
    res.json({ id, isPinned: next });
  }));

  router.post('/:id/undo-message', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    if (harness.busy(id)) throw new HttpError(409, 'SESSION_BUSY', 'phiên đang bận');
    const { messageId } = parseWith(undoMessageSchema, req.body, 'body');
    const events = harness.events.list(id);
    const target = events.find((event) => event.type === 'user/message'
      && (event.payload as { messageId?: string }).messageId === messageId);
    if (!target) throw new HttpError(404, 'MESSAGE_NOT_FOUND');
    const toSeq = Math.max(0, target.seq - 1);
    harness.events.append(id, [{ type: 'session/revert', payload: { toSeq } }]);
    res.json(harness.sessions.get(id));
  }));

  // Git-like branch: copy the effective log prefix up to `toSeq` (or the whole log) into a new
  // visible session. The source stays intact, so branching is the redo/checkout path after an undo.
  router.post('/:id/branch', api((req, res) => {    const id = sessionIdOf(req);
    requireSession(harness, id);
    const { toSeq } = parseWith(branchSchema, req.body ?? {}, 'body');
    const source = harness.sessions.get(id);
    if (!source) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const events = harness.events.list(id);
    const latestSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    const cut = toSeq === undefined ? latestSeq : Math.min(toSeq, latestSeq);
    const branch = harness.sessions.create(source.projectId, `${source.title} (branch)`, source.modelSelection);
    harness.events.copy(id, branch.id, cut);
    res.status(201).json(harness.sessions.get(branch.id));
  }));

  // Goals: a durable `goal/changed` event per write; the loop reads it back off the log for the
  // prompt, and `sessions.goal_id` only caches the current id.
  router.post('/:id/goal', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const { objective } = parseWith(goalSchema, req.body, 'body');
    const goalId = createId('goal');
    harness.events.append(id, [{ type: 'goal/changed', payload: { goalId, status: 'active', objective } }]);
    harness.sessions.setGoalCache(id, goalId);
    res.status(201).json({ id, goalId, status: 'active', objective });
  }));

  router.delete('/:id/goal', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    // End the latest logged goal (if any) so `activeGoal()` reads back as none.
    let goalId: string | null = null;
    let objective = '';
    for (const event of harness.events.list(id)) {
      if (event.type !== 'goal/changed') continue;
      const payload = event.payload as { goalId: string; status: string; objective: string };
      goalId = payload.goalId;
      objective = payload.objective;
    }
    if (goalId !== null) {
      harness.events.append(id, [{ type: 'goal/changed', payload: { goalId, status: 'done', objective } }]);
    }
    harness.sessions.setGoalCache(id, null);
    res.json({ ok: true, id });
  }));

  // Plan mode: one durable `plan/mode` whole-value-replace event; the loop reads it back off the
  // log for the prompt, so resume/fork/compaction recover it by folding the log (deepseek `plan-mode`).
  router.post('/:id/plan', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const { active } = parseWith(z.strictObject({ active: z.boolean() }), req.body, 'body');
    const state = setPlanMode(harness.events, id, active);
    res.status(201).json({ id, active: state.active });
  }));

  router.delete('/:id/plan', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    setPlanMode(harness.events, id, false);
    res.json({ ok: true, id });
  }));

  // Subagents start a real child session and return immediately (deepseek activation);
  // the parent transcript gets `subagent/start` at once and `subagent/end` on settlement.
  router.post('/:id/subagent', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const { task } = parseWith(subagentSchema, req.body, 'body');
    try {
      const started = subagents.start(id, task);
      res.status(202).json({ id, subagentId: started.subagentId, childSessionId: started.childSessionId, status: 'running' });
    } catch (error) {
      if (error instanceof SubagentDepthError) throw new HttpError(422, 'VALIDATION_ERROR', error.message);
      if (error instanceof SubagentBusyError) throw new HttpError(409, 'SESSION_BUSY', error.message);
      if (error instanceof Error && error.message === 'SESSION_NOT_FOUND') {
        throw new HttpError(404, 'SESSION_NOT_FOUND');
      }
      throw error;
    }
  }));

  router.get('/:id/subagent/list', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    res.json(subagents.listTree(id));
  }));

  router.post('/:id/subagent/:childId/interrupt', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const childId = pathParam(req.params.childId, 'childId');
    // Authorization: only descendants of this session may be interrupted.
    const tree = subagents.listTree(id);
    if (!tree.some((entry) => entry.childSessionId === childId)) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const interrupted = subagents.interrupt(childId);
    res.json({ id, childId, accepted: true, interrupted });
  }));

  router.delete('/:id', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    // Deleting a session must not leave a steer queue, a gate or an abort controller behind.
    harness.cancellations.cancel(id);
    harness.inbox.clear(id);
    harness.pipeline.releaseSession(id);
    harness.toolPrefs.clear(id);
    harness.jobs.clearSession(id);
    harness.sessions.delete(id);
    res.json({ ok: true, id });
  }));

  router.get('/:id/attachments', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    res.json(harness.attachments.listBySession(id));
  }));

  router.get('/:id/attachments/:attachmentId', api((req, res) => {
    const id = sessionIdOf(req);
    requireSession(harness, id);
    const attachmentId = pathParam(req.params.attachmentId, 'attachmentId');
    const record = harness.attachments.getById(attachmentId);
    if (!record || record.sessionId !== id) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND');
    res.json({
      id: record.id,
      name: record.name,
      mime: record.mime,
      size: record.size,
      data: record.data,
    });
  }));

  return router;
}
