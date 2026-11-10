import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function requireToken(expected: string): RequestHandler {
  return (req, res, next) => {
    const provided = req.header('x-morphi-token') || '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      return;
    }
    next();
  };
}
