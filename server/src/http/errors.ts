import type { ErrorRequestHandler, RequestHandler } from 'express';
import { redact } from './redact';

// The one envelope the whole client reads: `{ error: { code, message?, details? } }`, matching
// `HttpError.body()` — a client must never branch on two shapes (Task 18 ruling).
export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', details: { path: req.path } } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[http] unhandled error', redact(err instanceof Error ? err.stack ?? err.message : String(err)));
  res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
};
