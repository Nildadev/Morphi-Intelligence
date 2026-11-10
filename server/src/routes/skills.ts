import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { api, HttpError, parseWith, pathParam } from '../http/validation';

const toggleSchema = z.strictObject({ enabled: z.boolean() });

/** Presentation only — the skill body is injected into the system prompt, never served to the UI. */
function toMetadata(skill: { name: string; description: string; triggers: string[]; source: string }, active: boolean) {
  return {
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    source: skill.source,
    active,
  };
}

function toggleParams(req: Request): { sessionId: string; name: string } {
  return {
    sessionId: pathParam(req.params.sessionId, 'sessionId'),
    name: pathParam(req.params.name, 'name'),
  };
}

/**
 * Built-in skills for the in-app agent (superpowers-derived working agreement).
 * Global Constraints §1.1.0: no external/user skills, no plugin download, no network.
 */
export function createSkillsRouter(harness: Harness): Router {
  const router = Router();

  router.get('/skills', api((req, res) => {
    const { sessionId } = parseWith(
      z.strictObject({ sessionId: z.string().trim().min(1).max(120).optional() }),
      req.query,
      'query',
    );
    const active = new Set(sessionId ? harness.skills.active(sessionId) : []);
    res.json(harness.skills.list().map((skill) => toMetadata(skill, active.has(skill.name))));
  }));

  router.post('/sessions/:sessionId/skills/:name', api((req, res) => {
    const { sessionId, name } = toggleParams(req);
    const { enabled } = parseWith(toggleSchema, req.body, 'body');
    if (!harness.sessions.exists(sessionId)) throw new HttpError(404, 'SESSION_NOT_FOUND');
    // A typo must not become a switch that looks alive but can never inject a body.
    if (!harness.skills.get(name)) throw new HttpError(404, 'SKILL_NOT_FOUND');

    const next = new Set(harness.skills.active(sessionId));
    if (enabled) next.add(name);
    else next.delete(name);
    harness.skills.setActive(sessionId, [...next].sort());
    res.json({ sessionId, name, enabled });
  }));

  return router;
}
