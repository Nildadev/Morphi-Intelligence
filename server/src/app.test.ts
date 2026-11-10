import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
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
