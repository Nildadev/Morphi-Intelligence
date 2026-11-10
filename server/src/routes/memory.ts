import { Router } from 'express';
import type { Harness } from '../harness/harness';
import { api } from '../http/validation';

export function createMemoryRouter(harness: Harness): Router {
  const router = Router();

  router.get('/stats', api((_req, res) => {
    res.json(harness.memory.stats());
  }));

  router.delete('/', api((_req, res) => {
    // Counted before the wipe so the panel can confirm what it just removed.
    const before = harness.memory.stats();
    harness.memory.clear();
    res.json({ ok: true, cleared: { projects: before.projects, sessions: before.sessions, events: before.events } });
  }));

  return router;
}
