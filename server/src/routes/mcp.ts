import { Router } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { MCP_SETTINGS_ID, isAllowedMcpPath } from '../harness/mcp/serviceGateway';
import { api, HttpError, parseWith } from '../http/validation';

const pathSchema = z.strictObject({ path: z.string().trim().min(1).max(400).nullable() });

export function createMcpRouter(harness: Harness): Router {
  const router = Router();

  // Studio registers its place a few seconds after the proxy starts, and Morphi connects at boot —
  // so the first status read can honestly say "no place" while Place1 is open. A status read is the
  // moment somebody is looking, so re-probe there, throttled to one listing per 5 s.
  let lastProbe = 0;

  router.get('/status', api(async (_req, res) => {
    if (harness.mcp.connected && !harness.mcp.studio && Date.now() - lastProbe > 5_000) {
      lastProbe = Date.now();
      await harness.syncTools();
    }
    res.json(harness.mcpStatus());
  }));

  router.post('/reconnect', api(async (_req, res) => {
    await harness.mcp.reconnect();
    // The registry mirror is what the next turn's tool policy advertises, so it refreshes here too.
    await harness.syncTools();
    res.json(harness.mcpStatus());
  }));

  router.put('/path', api(async (req, res) => {
    const { path: candidate } = parseWith(pathSchema, req.body, 'body');
    if (candidate !== null && !isAllowedMcpPath(candidate)) {
      // Nothing is written and nothing reconnects, so a bad guess cannot replace a working path.
      throw new HttpError(400, 'MCP_PATH_REJECTED');
    }

    harness.providerSettings.setConfig(MCP_SETTINGS_ID, { baseUrl: candidate });
    await harness.mcp.reconnect();
    await harness.syncTools();
    res.json(harness.mcpStatus());
  }));

  return router;
}
