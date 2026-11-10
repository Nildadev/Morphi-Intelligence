import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { CUSTOM_PROVIDER_ID, KEYLESS_PROVIDER_IDS } from '../harness/llm/registry';
import { BRIDGE_PROVIDER_IDS, connectBridge, probeBridge } from '../services/deepseekChatBridge';
import { api, HttpError, parseWith, pathParam, rejectApiKeys } from '../http/validation';

/**
 * Strict on purpose: an unknown key is a client bug (or an attempt to smuggle a credential), and a
 * permissive schema would answer 200 while silently dropping what the sender meant. `baseUrl` is
 * accepted for `custom:*` rows and for the keyless bridge — see the guard in the config route.
 */
const configSchema = z
  .strictObject({
    baseUrl: z.string().trim().regex(/^https?:\/\/\S+$/, 'must be an http(s) endpoint').max(400).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((config) => config.baseUrl !== undefined || config.enabled !== undefined, {
    message: 'baseUrl or enabled is required',
  });

function providerRow(harness: Harness, status: { providerId: string; configured: boolean; enabled: boolean }) {
  const stored = harness.providerSettings.get(status.providerId);
  return {
    ...status,
    baseUrl: stored?.baseUrl ?? null,
    custom: status.providerId.startsWith('custom:'),
  };
}

function providerIdOf(req: Request): string {
  return pathParam(req.params.id, 'id');
}

export function createProvidersRouter(harness: Harness): Router {
  const router = Router();

  router.get('/', api((_req, res) => {
    res.json(harness.llm.providerStatus().map((status) => providerRow(harness, status)));
  }));

  /**
   * The DeepSeek bridge's own address. A stored `baseUrl` wins because the user may run it on another
   * port; the model list comes from the endpoint the same row names, so the status and the lineup
   * can never disagree about where the bridge lives.
   */
  function storedBaseUrlOf(id: string): string | undefined {
    return harness.providerSettings.get(id)?.baseUrl;
  }

  router.get('/:id/bridge', api(async (req, res) => {
    const id = providerIdOf(req);
    if (!BRIDGE_PROVIDER_IDS.has(id)) throw new HttpError(404, 'UNKNOWN_PROVIDER');
    // Reachability only: no session is created, nothing is charged against the account.
    res.json(await probeBridge(storedBaseUrlOf(id)));
  }));

  router.post('/:id/connect', api(async (req, res) => {
    const id = providerIdOf(req);
    if (!BRIDGE_PROVIDER_IDS.has(id)) throw new HttpError(404, 'UNKNOWN_PROVIDER');
    rejectApiKeys(req.body);
    const result = await connectBridge(storedBaseUrlOf(id));
    // A fresh session must show up in the model list, or the row would claim a connection the
    // picker cannot use.
    await harness.llm.refreshModels();
    res.json(result);
  }));

  router.put('/:id/config', api(async (req, res) => {
    const id = providerIdOf(req);
    rejectApiKeys(req.body);
    const config = parseWith(configSchema, req.body, 'body');
    // 1.1.0 fixes the four built-in base URLs. A stored `safeStorage` key travels to whatever host
    // the adapter is pointed at, so letting one request move `openai`/`google`/`openrouter` to an
    // arbitrary endpoint would exfiltrate the key as a bearer header; only `custom:<slug>` rows
    // own their endpoint, and only they may carry a `baseUrl`. A KEYLESS row is the other
    // exception: it stores no credential at all, so pointing the DeepSeek bridge at another port
    // leaks nothing (and the user who runs it on 8001 needs that).
    const ownsEndpoint = CUSTOM_PROVIDER_ID.test(id) || KEYLESS_PROVIDER_IDS.has(id);
    if (config.baseUrl !== undefined && !ownsEndpoint) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'baseUrl is only configurable for a custom or keyless provider');
    }

    const known = harness.llm.providerStatus().some((status) => status.providerId === id);
    if (!known) {
      if (!CUSTOM_PROVIDER_ID.test(id)) throw new HttpError(404, 'UNKNOWN_PROVIDER');
      if (config.baseUrl === undefined) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'baseUrl is required for a new custom provider');
      }
      harness.llm.addCustomProvider(id, config.baseUrl);
    }

    harness.llm.setProviderConfig(id, config);
    harness.providerSettings.setConfig(id, config);
    // The settings row is what `index.ts` replays on the next boot, so it is written before the
    // refresh; a failing endpoint cannot leave the connector half-registered.
    await harness.llm.refreshModels();
    res.json(providerRow(harness, harness.llm.providerStatus().find((status) => status.providerId === id)!));
  }));

  return router;
}
