import { Router } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { api, booleanFlag, parseWith } from '../http/validation';

const querySchema = z.strictObject({ usable: booleanFlag.optional() });

/**
 * `LlmRegistry.getModels()` is already usable-only (configured + enabled + refreshed), so `usable`
 * is validated rather than branched on: an unusable list is not something the harness can produce,
 * and the picker in Task 22 must never see a disabled provider's models.
 */
export function createModelsRouter(harness: Harness): Router {
  const router = Router();

  router.get('/', api((req, res) => {
    // `usable` is validated and then dropped: `getModels()` is usable-only, so Task 22's picker can
    // never list a disabled provider's models, with or without the flag.
    parseWith(querySchema, req.query, 'query');
    res.json(harness.llm.getModels());
  }));

  return router;
}
