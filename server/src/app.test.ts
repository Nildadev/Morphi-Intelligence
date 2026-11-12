import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { errorHandler } from './http/errors';
import { redact } from './http/redact';

const app = createApp({ token: 'secret-token', version: '1.1.0' });

describe('API security', () => {
  it('allows health without token', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.1.0');
  });

  it('rejects missing and wrong token', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).get('/api/projects').set('X-Morphi-Token', 'wrong')).status).toBe(401);
  });

  it('answers 401/404/500 with the single {error:{code}} envelope', async () => {
    // Task 18 unified every server error body on the `HttpError.body()` shape; Task 23 maps on
    // `error.code` without a second branch for the old flat `{ error: 'CODE' }` responses.
    expect((await request(app).get('/api/projects')).body).toEqual({ error: { code: 'UNAUTHORIZED' } });

    const missing = await request(app).get('/api/nope').set('X-Morphi-Token', 'secret-token');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND', details: { path: '/api/nope' } } });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const crashy = createApp({
        token: 'secret-token',
        version: '1.1.0',
        mount: (crashApp) => {
          crashApp.get('/api/boom', () => {
            throw new Error('kaboom');
          });
        },
      });
      const crashed = await request(crashy).get('/api/boom').set('X-Morphi-Token', 'secret-token');
      expect(crashed.status).toBe(500);
      expect(crashed.body).toEqual({ error: { code: 'INTERNAL_ERROR' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('answers a decoded-body failure with 4xx, not 500', async () => {
    // `express.json({strict:true})` treats a bare `null` / `42` / `"text"` payload as a parse error and
    // tags it `type: 'entity.parse.failed'`. The error middleware used to answer every one of those with
    // 500 INTERNAL_ERROR, which reads to the client as "the server is broken, retry" and wrote a stack
    // trace per call (MEASURED LIVE: 71 of 741 malformed requests were 5xx for this reason alone).
    const echo = createApp({
      token: 'secret-token',
      version: '1.1.0',
      mount: (mounted) => {
        mounted.post('/api/echo', (req, res) => res.json({ body: req.body ?? null }));
      },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const body of ['null', '42', '"text"', '{"name":']) {
        const res = await request(echo)
          .post('/api/echo')
          .set('X-Morphi-Token', 'secret-token')
          .set('Content-Type', 'application/json')
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: { code: 'INVALID_JSON' } });
      }
      // A well-formed body still arrives intact: the mapping must not swallow the route's own work.
      const ok = await request(echo)
        .post('/api/echo')
        .set('X-Morphi-Token', 'secret-token')
        .send({ name: 'kept' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ body: { name: 'kept' } });
      // A client-caused 4xx must not be logged as if it were a crash.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the status of a body-parser error it has no specific code for', async () => {
    // The app mounts `express.json` at 850mb, so the real 413 is unreachable in a test; this asserts the
    // mapping the middleware applies to any parser error carrying a 4xx status (aborted request, bad
    // framing, a limit from another mount) instead of collapsing all of them to 500.
    const fake = express();
    fake.get('/boom-large', () => {
      throw Object.assign(new Error('too big'), { type: 'entity.too.large', status: 413 });
    });
    fake.get('/boom-aborted', () => {
      throw Object.assign(new Error('aborted'), { statusCode: 408 });
    });
    // A status-less error is still a server bug and still gets logged. Registered before the handler,
    // because a route added after it never reaches it.
    fake.get('/boom-real', () => {
      throw new Error('kaboom');
    });
    fake.use(errorHandler);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const tooLarge = await request(fake).get('/boom-large');
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE' } });

      const aborted = await request(fake).get('/boom-aborted');
      expect(aborted.status).toBe(408);
      expect(aborted.body).toEqual({ error: { code: 'BAD_REQUEST' } });

      const real = await request(fake).get('/boom-real');
      expect(real.status).toBe(500);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects non-loopback origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN_ORIGIN' } });
  });

  it('allows loopback origins from another port (Vite dev proxy)', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
  });

  it('sets CSP and hides x-powered-by', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('redacts secrets from logs', () => {
    expect(redact('Bearer abc.def token 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).not.toContain('abc.def');
  });
});
