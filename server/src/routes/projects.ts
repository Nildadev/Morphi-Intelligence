import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { api, HttpError, parseWith, pathParam } from '../http/validation';

const createProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});

function projectIdOf(req: Request): string {
  return pathParam(req.params.id, 'id');
}

export function createProjectsRouter(harness: Harness): Router {
  const router = Router();

  router.get('/', api((_req, res) => {
    res.json(harness.projects.list());
  }));

  router.post('/', api((req, res) => {
    const input = parseWith(createProjectSchema, req.body, 'body');
    res.status(201).json(harness.projects.create(input.name, input.description));
  }));

  router.delete('/:id', api((req, res) => {
    const id = projectIdOf(req);
    // `ProjectStore.delete` is unconditional, so existence is checked here: a typo in the rail must
    // not answer 200 for a project that was never there. One row by primary key, not a scan.
    if (!harness.projects.get(id)) {
      throw new HttpError(404, 'PROJECT_NOT_FOUND');
    }
    for (const session of harness.sessions.list(id)) harness.toolPrefs.clear(session.id);
    harness.projects.delete(id);
    res.json({ ok: true, id });
  }));

  return router;
}
