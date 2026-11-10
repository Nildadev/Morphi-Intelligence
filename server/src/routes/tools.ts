import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import type { ToolDefinition } from '../harness/tools/types';
import { api, HttpError, parseWith, pathParam } from '../http/validation';

const listSchema = z.strictObject({ sessionId: z.string().trim().min(1).max(120).optional() });
const toggleSchema = z.strictObject({ enabled: z.boolean() });

/** Presentation only — `execute`, `timeoutMs` and the parameter schema never leave the server. */
function toMetadata(tool: ToolDefinition, enabled: boolean) {
  return {
    name: tool.name,
    description: tool.description,
    label: tool.presentation.label,
    risk: tool.presentation.risk,
    approval: tool.approval,
    concurrencySafe: tool.isConcurrencySafe,
    enabled,
  };
}

function toggleParams(req: Request): { sessionId: string; name: string } {
  return {
    sessionId: pathParam(req.params.sessionId, 'sessionId'),
    name: pathParam(req.params.name, 'name'),
  };
}

export function createToolsRouter(harness: Harness): Router {
  const router = Router();

  router.get('/tools', api((req, res) => {
    const { sessionId } = parseWith(listSchema, req.query, 'query');
    const metadata = harness.tools.list().map((tool) => toMetadata(tool, sessionId ? harness.toolPrefs.isEnabled(sessionId, tool.name) : true));
    res.json(metadata);
  }));

  router.post('/sessions/:sessionId/tools/:name', api((req, res) => {
    const { sessionId, name } = toggleParams(req);
    const { enabled } = parseWith(toggleSchema, req.body, 'body');
    if (!harness.sessions.exists(sessionId)) throw new HttpError(404, 'SESSION_NOT_FOUND');
    // Unknown names are refused instead of stored: a typo would silently look like a working switch.
    if (!harness.tools.has(name)) throw new HttpError(404, 'TOOL_NOT_FOUND');
    harness.toolPrefs.set(sessionId, name, enabled);
    res.json({ sessionId, name, enabled });
  }));

  return router;
}
