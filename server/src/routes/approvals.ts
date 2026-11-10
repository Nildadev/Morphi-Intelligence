import { Router } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { api, HttpError, parseWith, pathParam } from '../http/validation';

const decideSchema = z.strictObject({
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']),
});

/**
 * The one approval surface: the SSE stream announced `approval/request`, this settles it.
 * `ApprovalService.decide` is the single writer of the `approval/decision` row — an id it does not
 * know (expired, decided twice, never asked) answers 404 instead of silently accepting a vote.
 */
export function createApprovalsRouter(harness: Harness): Router {
  const router = Router();

  router.post('/:id', api((req, res) => {
    const approvalId = pathParam(req.params.id, 'id');
    const input = parseWith(decideSchema, req.body, 'body');
    if (!harness.approvals.decide(approvalId, input.decision, input.scope)) {
      throw new HttpError(404, 'APPROVAL_NOT_FOUND');
    }
    res.json({ ok: true, approvalId, decision: input.decision, scope: input.scope });
  }));

  return router;
}
