import express, { type Express } from 'express';
import { requireToken } from './http/auth';
import { loopbackOnly, securityHeaders } from './http/security';
import { errorHandler, notFound } from './http/errors';

export interface AppOptions {
  token: string;
  version: string;
  staticDir?: string;
  mount?: (app: Express) => void;
}

export function createApp({ token, version, staticDir, mount }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(loopbackOnly);
  app.use(securityHeaders);
  // Must admit everything the chat schema admits: 12 attachments × 70MB base64 ≈ 840MB, plus the
  // message and field overhead. A lower cap turns a schema-valid image into a 413 → generic 500.
  app.use(express.json({ limit: '850mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, version }));
  app.use('/api', requireToken(token));
  mount?.(app);

  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile('index.html', { root: staticDir });
    });
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
