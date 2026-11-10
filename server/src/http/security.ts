import type { RequestHandler } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export const loopbackOnly: RequestHandler = (req, res, next) => {
  // Same `{ error: { code } }` envelope as `HttpError.body()`, `auth.ts` and `errors.ts` (Task 18).
  if (!LOOPBACK.has(req.hostname)) {
    res.status(403).json({ error: { code: 'FORBIDDEN_HOST' } });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (!LOOPBACK.has(url.hostname)) {
        res.status(403).json({ error: { code: 'FORBIDDEN_ORIGIN' } });
        return;
      }
    } catch {
      res.status(403).json({ error: { code: 'FORBIDDEN_ORIGIN' } });
      return;
    }
  }
  next();
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};
