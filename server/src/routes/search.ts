import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { api, HttpError, parseWith } from '../http/validation';

const searchSchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sessionId: z.string().trim().min(1).max(120).optional(),
});

/**
 * Content search over session history (deepseek `dsh-session-query`): ranked FTS hits
 * with snippets, usable by the SearchPalette and by a model-facing consumer.
 */
export function createSearchRouter(harness: Harness): Router {
  const router = Router();

  router.get('/', api((req: Request, res) => {
    const { q, limit, offset, sessionId } = parseWith(searchSchema, req.query, 'query');
    if (sessionId !== undefined && !harness.sessions.exists(sessionId)) {
      throw new HttpError(404, 'SESSION_NOT_FOUND');
    }
    res.json(harness.query.search(q, { limit, offset, sessionId }));
  }));

  return router;
}
