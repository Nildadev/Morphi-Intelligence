import { Router } from 'express';
import { z } from 'zod';
import type { Harness } from '../harness/harness';
import { FileReferenceProvider } from '../harness/context/fileReference';
import { api, parseWith } from '../http/validation';

const listSchema = z.strictObject({
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** `@file` candidates for host UIs (deepseek `fileReferences/list`). Advisory only. */
export function createFileReferenceRouter(_harness: Harness): Router {
  const router = Router();
  const provider = new FileReferenceProvider(process.cwd());

  router.get('/', api((req, res) => {
    const { q, limit } = parseWith(listSchema, req.query, 'query');
    res.json(provider.list(q ?? '', limit ?? 50));
  }));

  return router;
}
