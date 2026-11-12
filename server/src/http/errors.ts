import type { ErrorRequestHandler, RequestHandler } from 'express';
import { redact } from './redact';

// The one envelope the whole client reads: `{ error: { code, message?, details? } }`, matching
// `HttpError.body()` — a client must never branch on two shapes (Task 18 ruling).
export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', details: { path: req.path } } });
};

/**
 * Errors body-parser raises before any route runs. `strict: true` JSON rejects a bare `null`, `42` or
 * `"text"` payload as a parse error, and the parser marks it `type: 'entity.parse.failed'` / status 400.
 * Answering those with 500 told the client the request was fine and the server was broken (MEASURED
 * LIVE: 71 of 741 malformed requests came back 5xx, every one of them a 4xx body-parser error), and it
 * logged a stack trace per call.
 */
const BODY_ERRORS: Record<string, { status: number; code: string }> = {
  'entity.parse.failed': { status: 400, code: 'INVALID_JSON' },
  'entity.too.large': { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  'encoding.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING' },
  'charset.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING' },
  'request.aborted': { status: 400, code: 'REQUEST_ABORTED' },
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (typeof err === 'object' && err !== null) {
    const { type, status, statusCode } = err as { type?: unknown; status?: unknown; statusCode?: unknown };
    const mapped = typeof type === 'string' ? BODY_ERRORS[type] : undefined;
    if (mapped) {
      res.status(mapped.status).json({ error: { code: mapped.code } });
      return;
    }
    // Anything else carrying a 4xx status came from the caller as well — an abort, a bad framing, a
    // limit. Only a 5xx or a status-less error is a bug worth a stack trace.
    const clientStatus = typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : undefined;
    if (clientStatus !== undefined && clientStatus >= 400 && clientStatus < 500) {
      res.status(clientStatus).json({ error: { code: 'BAD_REQUEST' } });
      return;
    }
  }
  console.error('[http] unhandled error', redact(err instanceof Error ? err.stack ?? err.message : String(err)));
  res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
};
