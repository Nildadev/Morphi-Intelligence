import type { RequestHandler, Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { redact } from './redact';

export class HttpError extends Error {
  /**
   * `message` is inherited from `Error` (and always set), so the optional human-facing text lives
   * under its own name; `body()` is what the client actually reads.
   */
  readonly detail?: string;
  readonly details?: unknown;

  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
    details?: unknown,
  ) {
    super(detail ?? code);
    this.name = 'HttpError';
    this.detail = detail;
    this.details = details;
  }

  /** `{ error: { code } }` unless there is something more to say; Task 23 maps on `code`. */
  body(): { error: Record<string, unknown> } {
    return {
      error: {
        code: this.code,
        ...(this.detail ? { message: redact(this.detail) } : {}),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/**
 * A body carrying a key is refused before anything else runs: the harness never accepts or returns
 * a credential over HTTP (`safeStorage` in Electron main owns them), so the rejection has its own
 * code instead of a generic schema complaint.
 */
export function rejectApiKeys(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.apiKey !== undefined || record.api_key !== undefined) {
    throw new HttpError(400, 'API_KEY_NOT_ACCEPTED');
  }
}

export function parseWith<S extends ZodType>(schema: S, value: unknown, source: 'body' | 'query' | 'params'): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(400, 'VALIDATION_ERROR', `${source} is invalid`, result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  })));
}

/**
 * Routes are written as `async (req, res) => { ... }` and throw `HttpError`; this is the one place
 * that turns a thrown error into the response shape the client expects and hands anything else to
 * the app's error middleware.
 */
export function api(handler: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (error instanceof HttpError) {
          res.status(error.status).json(error.body());
          return;
        }
        next(error);
      });
  };
}

export const booleanFlag = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((value) =>
  typeof value === 'boolean' ? value : value === 'true',
);

/**
 * Express 5 types a path parameter as `string | string[]`, because a repeated segment is legal in
 * a raw URL; every route here declares one value per segment, so narrow it in one place and reject
 * the rest instead of letting an array reach `SessionStore.get`.
 */
export function pathParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  throw new HttpError(400, 'VALIDATION_ERROR', `path parameter ${name} is invalid`, [
    { path: name, code: 'invalid_type', message: `Expected one non-empty ${name}` },
  ]);
}
