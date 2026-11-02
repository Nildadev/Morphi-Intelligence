# Morphi Intelligence 1.1.0 — Harness & UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây harness nội bộ đầy đủ, đổi UI sang ChatGPT desktop tiếng Việt, sửa toàn bộ lỗi P0/P1 và phát hành 1.1.0 ổn định.

**Architecture:** Electron main sở hữu `safeStorage` và token, chạy Express server trong `utilityProcess` bind loopback port động. Server dùng event-sourced SQLite làm nguồn sự thật, agent loop turn/step, tool pipeline có approval, provider seam và compaction. Client React gọi relative `/api`, nhận SSE envelope và render từ projection.

**Tech Stack:** Electron 31, React 19, Vite 7, Tailwind 4, Express 5, better-sqlite3, zod, Vitest, supertest, Playwright, TypeScript strict.

**Spec:** [2026-11-02-morphi-harness-ui-design.md](../specs/2026-11-02-morphi-harness-ui-design.md)

## Global Constraints

- Version `1.1.0` cho root, client, server; `engines.node >= 20.18`; Electron 31.
- Server chỉ bind `127.0.0.1`, port `0` khi chạy trong Electron; mọi API trừ `/api/health` yêu cầu `X-Morphi-Token`.
- UI luôn gọi relative `/api`; không hardcode `localhost:3000`.
- API key chỉ nằm trong Electron main (`safeStorage`), truyền server qua `parentPort`; không có endpoint HTTP nhận/trả key; không lưu key trong localStorage.
- DB cũ được đổi tên thành `morphi.db.v1.bak`, không xoá; schema mới không có bảng `notes`.
- MCP pin `robloxstudio-mcp@2.6.0`; production spawn bằng Electron Node, không phụ thuộc Node cài sẵn.
- UI tiếng Việt, chuỗi tập trung tại `client/src/i18n/vi.ts`; không copy tab Chat/Work hay usage card giả.
- Chỉ dùng built-in plugin/skill/workflow trong 1.1.0; không tải plugin bên thứ ba.
- TDD: mỗi task viết test fail trước, implement tối thiểu, chạy pass. Test server dùng Vitest + supertest; test UI dùng Vitest + Testing Library; E2E dùng Playwright.
- Commit chỉ được tạo khi người dùng đã cho phép commit. Kết thúc mỗi task là một diff review; nếu chưa được phép, dừng ở checkpoint và ghi suggested commit message.
- Mọi task UI phải chạy `npm run dev` và thao tác thật trên browser; task cuối phải kiểm tra cả app đóng gói thật. Không tuyên bố hoàn thành chỉ dựa vào typecheck.

---

## File Structure

```text
main.js                         Electron lifecycle, single-instance, window
preload.js                      contextBridge: token + credentials IPC
main/
  backend.js                    utilityProcess fork, ready handshake, restart
  credentials.js                safeStorage credential store
  ipc.js                        IPC handlers
server/
  src/
    config.ts                   runtime config từ env
    app.ts                      Express app factory + security
    index.ts                    server bootstrap (utilityProcess hoặc dev)
    http/
      auth.ts security.ts errors.ts sse.ts validation.ts
    db/
      connection.ts schema.ts
    harness/
      shared/    id.ts types.ts
      events/    types.ts store.ts
      session/   store.ts projections.ts title.ts
      tools/     types.ts registry.ts approval.ts pipeline.ts builtin/
      agent/     loop.ts inbox.ts cancellation.ts retry.ts
      prompt/    assemble.ts sections.ts
      llm/       types.ts sse.ts openaiCompatible.ts gemini.ts registry.ts settings.ts fake.ts
      compaction/estimator.ts pruner.ts summarizer.ts service.ts
      plugins/   registry.ts index.ts
      skills/    loader.ts builtin/*.md
      goals/     service.ts runner.ts
      workflows/ engine.ts builtin/
      subagents/ runtime.ts
      mcp/       serviceGateway.ts entry.ts
      harness.ts  composition root
    routes/      index.ts projects.ts sessions.ts chat.ts approvals.ts providers.ts models.ts tools.ts mcp.ts memory.ts skills.ts goals.ts workflows.ts
  test/          db.ts fixtures/
client/
  src/
    i18n/vi.ts
    lib/         api.ts sse.ts token.ts sessionGroups.ts chatReducer.ts
    components/
      layout/    AppShell.tsx Rail.tsx Sidebar.tsx Header.tsx SearchPalette.tsx
      chat/      ChatView.tsx WelcomeView.tsx Composer.tsx ModelPicker.tsx
                 MessageItem.tsx ThinkingBlock.tsx ToolCallCard.tsx ApprovalModal.tsx ErrorCard.tsx
      settings/  SettingsModal.tsx
      harness/   GoalBar.tsx SubagentCard.tsx WorkflowTimeline.tsx SkillPicker.tsx
    test/setup.ts
  e2e/           *.spec.ts
.github/workflows/ci.yml
LICENSE .env.example .editorconfig
```

---

# Phase 1 — Foundation & Stabilize

### Task 1: Test toolchain, config, shared IDs

**Files:**
- Create: `server/vitest.config.ts`, `server/src/harness/shared/id.ts`, `server/src/config.ts`
- Test: `server/src/harness/shared/id.test.ts`, `server/src/config.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: none.
- Produces: `createId(prefix: string): string`; `RuntimeConfig`; `loadConfig(env?: NodeJS.ProcessEnv): RuntimeConfig`.

- [ ] **Step 1: Write failing ID test**

```ts
import { describe, expect, it } from 'vitest';
import { createId } from './id';

describe('createId', () => {
  it('prefixes and stays unique', () => {
    const a = createId('turn');
    const b = createId('turn');
    expect(a).toMatch(/^turn_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd server && npx vitest run src/harness/shared/id.test.ts`
Expected: FAIL because `./id` does not exist.

- [ ] **Step 3: Implement ID helper**

```ts
import { randomUUID } from 'node:crypto';

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
```

- [ ] **Step 4: Write failing config test**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses electron defaults for port and token mode', () => {
    const config = loadConfig({ MORPHI_MODE: 'electron', MORPHI_TOKEN: 'abc', APPDATA: 'C:/data' });
    expect(config.port).toBe(0);
    expect(config.token).toBe('abc');
    expect(config.isDev).toBe(false);
  });

  it('uses dev token and port 3000 outside electron', () => {
    const config = loadConfig({ APPDATA: 'C:/data' });
    expect(config.port).toBe(3000);
    expect(config.token).toBe('dev-token');
    expect(config.isDev).toBe(true);
  });
});
```

- [ ] **Step 5: Run test — expect failure**

Run: `cd server && npx vitest run src/config.test.ts`
Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 6: Implement config**

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeConfig {
  token: string;
  port: number;
  dbPath: string;
  clientDistPath: string;
  isDev: boolean;
  titleModel: string;
  autoPriority: string[];
  compaction: { pruneAt: number; summarizeAt: number; keepRecentTurns: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const electron = env.MORPHI_MODE === 'electron';
  const appData = env.APPDATA || path.join(env.HOME || process.cwd(), '.local', 'share');
  const settingsPath = path.join(appData, 'MorphiIntelligence', 'settings.json');
  let settings: any = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* defaults */ }
  return {
    token: env.MORPHI_TOKEN || (electron ? '' : 'dev-token'),
    port: Number(env.MORPHI_PORT ?? (electron ? 0 : 3000)),
    dbPath: env.MORPHI_DB_PATH || path.join(appData, 'MorphiIntelligence', 'morphi.db'),
    clientDistPath: path.join(__dirname, '../../client/dist'),
    isDev: !electron,
    titleModel: env.MORPHI_TITLE_MODEL || settings.titleModel || 'auto',
    autoPriority: settings.autoPriority || ['google', 'openai', 'openrouter', 'proxypal', 'custom'],
    compaction: {
      pruneAt: settings.compaction?.pruneAt ?? 0.7,
      summarizeAt: settings.compaction?.summarizeAt ?? 0.85,
      keepRecentTurns: settings.compaction?.keepRecentTurns ?? 6,
    },
  };
}
```

- [ ] **Step 7: Add test scripts and Vitest config**

`server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
```

`server/package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"typecheck": "tsc --noEmit"`. Add dev deps `vitest`, `supertest`, `@types/supertest` via `npm install -D vitest supertest @types/supertest`; add `zod` via `npm install zod`.

- [ ] **Step 8: Run tests — expect pass**

Run: `cd server && npm test -- --run src/harness/shared/id.test.ts src/config.test.ts`
Expected: PASS 3 tests.

- [ ] **Step 9: Commit checkpoint**

Review diff. Suggested message: `chore(server): add vitest baseline and runtime config`.

---

### Task 2: Secure Express app factory

**Files:**
- Create: `server/src/http/auth.ts`, `server/src/http/security.ts`, `server/src/http/errors.ts`, `server/src/http/redact.ts`, `server/src/app.ts`
- Test: `server/src/app.test.ts`
- Modify: `server/src/index.ts` later in Task 3.

**Interfaces:**
- Consumes: none.
- Produces: `createApp(options: { token: string; version: string; staticDir?: string; mount?: (app: Express) => void }): Express`; `requireToken(token: string): RequestHandler`; `loopbackOnly: RequestHandler`.

- [ ] **Step 1: Write failing security tests**

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
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

  it('rejects non-loopback origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
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
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd server && npx vitest run src/app.test.ts`
Expected: FAIL because `createApp` does not exist.

- [ ] **Step 3: Implement auth, security, errors**

`server/src/http/auth.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function requireToken(expected: string): RequestHandler {
  return (req, res, next) => {
    const provided = req.header('x-morphi-token') || '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    next();
  };
}
```

`server/src/http/security.ts`:

```ts
import type { RequestHandler } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export const loopbackOnly: RequestHandler = (req, res, next) => {
  if (!LOOPBACK.has(req.hostname)) {
    res.status(403).json({ error: 'FORBIDDEN_HOST' });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (!LOOPBACK.has(url.hostname)) {
        res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
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
```

`server/src/http/errors.ts`:

```ts
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { redact } from './redact';

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[http] unhandled error', redact(err instanceof Error ? err.stack ?? err.message : String(err)));
  res.status(500).json({ error: 'INTERNAL_ERROR' });
};
```

`server/src/http/redact.ts`:

```ts
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|[0-9a-f]{64})/g;

export function redact(value: string): string {
  return value.replace(SECRET, '[redacted]');
}
```

Use `redact` for all server-side log lines that may contain provider errors, URLs, or MCP stderr.

- [ ] **Step 4: Implement app factory**

```ts
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
  app.use(express.json({ limit: '2mb' }));

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
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd server && npx vitest run src/app.test.ts`
Expected: PASS 6 tests.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(server): add token and loopback-only app factory`.

---

### Task 3: Electron utilityProcess topology and preload token

**Files:**
- Create: `main/backend.js`, `preload.js`, `main/backend.test.js`
- Modify: `main.js`, `server/src/index.ts`, `package.json`
- Test: `main/backend.test.js` (Node test runner)

**Interfaces:**
- Consumes: `RuntimeConfig` from Task 1.
- Produces: `startBackend({ appPath, env }): { token, child, ready: Promise<{port:number}> }`; preload API `window.morphi.getToken(): Promise<string>`.

- [ ] **Step 1: Write failing ready-handshake test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createReadyPromise } = require('./backend');

test('resolves the actual port from the child message', async () => {
  const child = new EventEmitter();
  const ready = createReadyPromise(child, 1000);
  child.emit('message', { type: 'ready', port: 41234 });
  assert.deepStrictEqual(await ready, { port: 41234 });
});

test('rejects on timeout', async () => {
  const child = new EventEmitter();
  await assert.rejects(createReadyPromise(child, 10), /SERVER_START_TIMEOUT/);
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `node --test main/backend.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement backend fork**

```js
const { utilityProcess } = require('electron');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

function createReadyPromise(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SERVER_START_TIMEOUT')), timeoutMs);
    child.on('message', (message) => {
      if (message && message.type === 'ready') {
        clearTimeout(timer);
        resolve({ port: message.port });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`SERVER_EXITED_${code}`));
    });
  });
}

function startBackend({ appPath, env }) {
  const token = randomBytes(32).toString('hex');
  const child = utilityProcess.fork(path.join(appPath, 'server', 'dist', 'index.js'), [], {
    env: { ...env, MORPHI_MODE: 'electron', MORPHI_TOKEN: token, MORPHI_PORT: '0' },
    stdio: 'pipe',
  });
  child.stdout?.on('data', (data) => process.stdout.write(`[server] ${data}`));
  child.stderr?.on('data', (data) => process.stderr.write(`[server] ${data}`));
  return { token, child, ready: createReadyPromise(child) };
}

module.exports = { startBackend, createReadyPromise };
```

- [ ] **Step 4: Implement preload**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morphi', {
  getToken: () => ipcRenderer.invoke('morphi:token'),
  credentials: {
    set: (providerId, apiKey) => ipcRenderer.invoke('morphi:credentials:set', { providerId, apiKey }),
    delete: (providerId) => ipcRenderer.invoke('morphi:credentials:delete', { providerId }),
    status: () => ipcRenderer.invoke('morphi:credentials:status'),
  },
});
```

- [ ] **Step 5: Rewrite main.js and server bootstrap**

`server/src/index.ts`:

```ts
import { createServer } from 'node:http';
import { loadConfig } from './config';
import { createApp } from './app';

const config = loadConfig();
const app = createApp({ token: config.token, version: '1.1.0', staticDir: config.clientDistPath });
const server = createServer(app);
const parentPort = (process as unknown as { parentPort?: { on: Function; postMessage: Function } }).parentPort;

if (parentPort) {
  parentPort.on('message', () => undefined);
}

server.listen(config.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  parentPort?.postMessage({ type: 'ready', port });
  console.log(`Morphi server listening on http://127.0.0.1:${port}`);
});
```

`main.js` must use `app.requestSingleInstanceLock()` (second instance focuses the existing window), `startBackend`, `ipcMain.handle('morphi:token')`, a `BrowserWindow` with `preload: path.join(__dirname, 'preload.js')`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, block `will-navigate`, and open only `https://` links with `shell.openExternal`. Load `http://127.0.0.1:${port}` only after `backend.ready`.

Add a restart policy: on `backend.child.exit`, if the app is not quitting and `restartCount < 3`, restart after 1s/3s/8s; when the new backend is ready, reload the window. After the third failure, show `dialog.showErrorBox('Không thể khởi động server', message)` instead of leaving a blank window. A 15s ready timeout triggers the same error dialog.

- [ ] **Step 6: Build and manual smoke test**

Run: `npm run build && npm start`
Expected: window loads, DevTools console shows no token in URL, `window.morphi.getToken()` resolves a 64-char hex string, `http://127.0.0.1:<port>/api/health` returns 200 and `/api/projects` returns 401 without the header.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(electron): run server in utilityProcess with dynamic port and token`.

---

### Task 4: safeStorage credential store and IPC

**Files:**
- Create: `main/credentials.js`, `main/credentials.test.js`, `main/ipc.js`, `server/src/credentials.ts`
- Modify: `main.js`, `server/src/index.ts`, `package.json`
- Test: `main/credentials.test.js`

**Interfaces:**
- Consumes: none.
- Produces: `createCredentialStore({ safeStorage, filePath, memory? }): { persistent, set, get, delete, all, status }`; IPC channels `morphi:credentials:set`, `morphi:credentials:delete`, `morphi:credentials:status`; server-side `setCredentials(keys)`, `getCredential(providerId)`, `configuredProviders()`.

`createCredentialStore().status()` returns the spec's `{ providerId, configured }[]`; the IPC handler wraps it as `{ persistent, providers }` so Settings can warn when safeStorage is unavailable.

- [ ] **Step 1: Write failing store tests**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('./credentials');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
  };
}

test('persists encrypted credentials and reports status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-cred-'));
  const file = path.join(dir, 'credentials.json');
  const store = createCredentialStore({ safeStorage: fakeSafeStorage(), filePath: file });
  store.set('openai', 'sk-test');
  assert.strictEqual(store.get('openai'), 'sk-test');
  assert.deepStrictEqual(store.status(), [{ providerId: 'openai', configured: true }]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-test'));
  store.delete('openai');
  assert.strictEqual(store.get('openai'), undefined);
});

test('falls back to session memory when safeStorage is unavailable', () => {
  const store = createCredentialStore({ safeStorage: fakeSafeStorage(false), filePath: 'ignored.json' });
  store.set('google', 'key');
  assert.strictEqual(store.get('google'), 'key');
  assert.strictEqual(store.persistent, false);
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `node --test main/credentials.test.js`
Expected: FAIL because `createCredentialStore` does not exist.

- [ ] **Step 3: Implement credential store**

```js
const fs = require('node:fs');
const path = require('node:path');

function createCredentialStore({ safeStorage, filePath }) {
  const persistent = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  const memory = new Map();
  const read = () => {
    if (!persistent) return {};
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
  };
  const write = (data) => {
    if (!persistent) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 });
  };
  return {
    persistent,
    set(providerId, apiKey) {
      if (!persistent) { memory.set(providerId, apiKey); return; }
      const data = read();
      data[providerId] = safeStorage.encryptString(apiKey).toString('base64');
      write(data);
    },
    get(providerId) {
      if (!persistent) return memory.get(providerId);
      const value = read()[providerId];
      return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : undefined;
    },
    delete(providerId) {
      memory.delete(providerId);
      const data = read();
      delete data[providerId];
      write(data);
    },
    all() {
      if (!persistent) return Object.fromEntries(memory);
      return Object.fromEntries(Object.keys(read()).map((id) => [id, this.get(id)]));
    },
    status() {
      const ids = persistent ? Object.keys(read()) : [...memory.keys()];
      return ids.map((providerId) => ({ providerId, configured: true }));
    },
  };
}

module.exports = { createCredentialStore };
```

- [ ] **Step 4: Wire IPC and server handoff**

`main/ipc.js` registers the three handlers, calls `store.set/delete`, then pushes the full decrypted key map to the server:

```js
function registerIpc({ ipcMain, store, getBackend }) {
  const push = () => {
    const backend = getBackend();
    backend?.child.postMessage({ type: 'credentials', keys: store.all() });
  };
  ipcMain.handle('morphi:credentials:set', (_event, { providerId, apiKey }) => {
    store.set(providerId, apiKey);
    push();
    return { ok: true, persistent: store.persistent };
  });
  ipcMain.handle('morphi:credentials:delete', (_event, { providerId }) => {
    store.delete(providerId);
    push();
    return { ok: true };
  });
  ipcMain.handle('morphi:credentials:status', () => ({
    persistent: store.persistent,
    providers: store.status(),
  }));
}
module.exports = { registerIpc };
```

In `server/src/index.ts`, add a `parentPort.on('message')` branch: on `{ type: 'credentials', keys }`, call `setCredentials(keys)`. Push once immediately after the backend is ready so restarts receive keys. `server/src/credentials.ts` is a deliberately small in-memory holder until the LLM registry exists in Task 13:

```ts
const keys = new Map<string, string>();

export function setCredentials(next: Record<string, string>): void {
  keys.clear();
  for (const [providerId, apiKey] of Object.entries(next)) {
    if (apiKey) keys.set(providerId, apiKey);
  }
}

export function getCredential(providerId: string): string | undefined {
  return keys.get(providerId);
}

export function configuredProviders(): string[] {
  return [...keys.keys()];
}
```

- [ ] **Step 5: Run tests and manual IPC smoke**

Run: `node --test main/credentials.test.js`
Expected: PASS 2 tests. Then start the app, open Settings, save a dummy key, restart the app, and confirm the key still works without the key ever appearing in `localStorage`, URL, or server logs.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(electron): store provider keys with safeStorage and IPC handoff`.

---

### Task 5: Client API transport and SSE parser

**Files:**
- Create: `client/src/lib/sse.ts`, `client/src/lib/token.ts`, `client/src/lib/sse.test.ts`, `client/vitest.config.ts`
- Modify: `client/src/lib/api.ts`, `client/package.json`, `client/vite.config.ts`
- Test: `client/src/lib/sse.test.ts`

**Interfaces:**
- Consumes: preload API from Task 3.
- Produces: `createSSEParser(onData: (data: string) => void): (chunk: string, flush?: boolean) => void`; `getToken(): Promise<string>`; `api` keeps existing method names until Phase 2.

- [ ] **Step 1: Write failing parser test**

```ts
import { describe, expect, it } from 'vitest';
import { createSSEParser } from './sse';

describe('createSSEParser', () => {
  it('handles chunk boundaries and multiple data lines', () => {
    const seen: string[] = [];
    const feed = createSSEParser((data) => seen.push(data));
    feed('data: {"a":');
    feed('1}\n\ndata: {"b":2}\n\n');
    feed('data: {"c":3}', true);
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd client && npx vitest run src/lib/sse.test.ts`
Expected: FAIL because `sse.ts` does not exist.

- [ ] **Step 3: Implement parser**

```ts
export function createSSEParser(onData: (data: string) => void) {
  let buffer = '';
  return (chunk: string, flush = false) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) onData(trimmed.slice(5).trim());
    }
    if (flush && buffer.trim().startsWith('data:')) {
      onData(buffer.trim().slice(5).trim());
      buffer = '';
    }
  };
}
```

- [ ] **Step 4: Add token helper**

```ts
declare global {
  interface Window {
    morphi?: {
      getToken(): Promise<string>;
      credentials: {
        set(providerId: string, apiKey: string): Promise<{ ok: boolean; persistent?: boolean }>;
        delete(providerId: string): Promise<{ ok: boolean }>;
        status(): Promise<{ persistent: boolean; providers: { providerId: string; configured: boolean }[] }>;
      };
    };
  }
}

let cached: string | undefined;

export async function getToken(): Promise<string> {
  if (cached) return cached;
  if (window.morphi) {
    cached = await window.morphi.getToken();
    return cached;
  }
  if (!import.meta.env.DEV) throw new Error('MORPHI_TOKEN_UNAVAILABLE');
  return 'dev-token';
}
```

- [ ] **Step 5: Update api.ts transport and SSE error handling**

Set `const API_BASE = '/api';`. Add a `request` helper that awaits `getToken()` and sets `X-Morphi-Token`. Replace the SSE loop with `createSSEParser`. Parse each JSON line outside the transport `try/catch`; on `data.type === 'error'`, call `onError(data.payload.message)` once and return. Keep the existing method signatures so Phase 2 can replace them without breaking the UI.

- [ ] **Step 6: Add Vite dev proxy**

`client/vite.config.ts` must proxy the relative API to the dev server:

```ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
```

Dev mode uses `dev-token` on both sides (`loadConfig` and `getToken`). The proxy's Origin is `http://localhost:5173`, which Task 2's loopback check accepts.

- [ ] **Step 7: Add client test scripts**

Run: `cd client && npm install -D vitest`.
`client/package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`.
`client/vitest.config.ts`: `test: { environment: 'node', include: ['src/**/*.test.ts'] }`.

- [ ] **Step 8: Run tests — expect pass**

Run: `cd client && npm test -- --run src/lib/sse.test.ts`
Expected: PASS 1 test.

- [ ] **Step 9: Commit checkpoint**

Suggested message: `fix(client): use relative API base, token header, and explicit SSE errors`.

---

### Task 6: First-message bug and cooperative cancel

**Files:**
- Create: `server/src/harness/agent/cancellation.ts`, `server/src/harness/agent/cancellation.test.ts`
- Modify: `server/src/routes/chatRoutes.ts`, `client/src/components/ChatInterface.tsx`, `client/src/lib/api.ts`
- Test: `server/src/harness/agent/cancellation.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `CancellationRegistry` with `start(key)`, `has(key)`, `cancel(key)`, `finish(key, controller)`.

- [ ] **Step 1: Write failing cancellation test**

```ts
import { describe, expect, it } from 'vitest';
import { CancellationRegistry } from './cancellation';

describe('CancellationRegistry', () => {
  it('aborts the active controller once and cleans up', () => {
    const registry = new CancellationRegistry();
    const controller = registry.start('s1');
    expect(registry.has('s1')).toBe(true);
    expect(registry.cancel('s1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    registry.finish('s1', controller);
    expect(registry.cancel('s1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd server && npx vitest run src/harness/agent/cancellation.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement registry and wire old chat route**

```ts
export class CancellationRegistry {
  private active = new Map<string, AbortController>();

  start(key: string): AbortController {
    const controller = new AbortController();
    this.active.set(key, controller);
    return controller;
  }

  has(key: string): boolean {
    return this.active.has(key);
  }

  cancel(key: string): boolean {
    const controller = this.active.get(key);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  finish(key: string, controller: AbortController): void {
    if (this.active.get(key) === controller) this.active.delete(key);
  }
}
```

In `chatRoutes.ts`, create a controller at stream start, check `controller.signal.aborted` in the chunk loop and call `stream.return(undefined)` before breaking, then `finish` in `finally`. Add `POST /api/chat/cancel` accepting `{ sessionId }` and calling `cancellationRegistry.cancel(sessionId)`.

- [ ] **Step 4: Fix stale project ID in ChatInterface**

Replace the `handleSend` project block with a local variable that is used for `createSession`:

```ts
let projectId = currentProjectId;
if (!projectId) {
  const project = await api.createProject('My Project');
  projectId = project.id;
  setProjects((prev) => [project, ...prev]);
  setCurrentProjectId(project.id);
}
const newSession = await api.createSession(projectId, title);
```

- [ ] **Step 5: Add client cancel call**

Add `cancelChat(sessionId: string)` to `api.ts` calling `POST /api/chat/cancel`. In `handleStop`, call `api.cancelChat(currentSessionId)` before aborting the fetch, and ignore the expected abort error.

- [ ] **Step 6: Run tests and manual first-message test**

Run: `cd server && npx vitest run src/harness/agent/cancellation.test.ts`.
Expected: PASS.
Manual: delete/rename the dev DB, start the app, send the first message in a fresh install, and confirm it creates a project, session, and assistant response without reload.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `fix(chat): create session with fresh project id and propagate stop to server`.

---

### Task 7: Repo cleanup, versions, license, CI skeleton

**Files:**
- Delete: `client/src/App.css`, `client/src/components/NotesManager.tsx`, `client/src/components/StepIndicator.tsx`, `server/src/test-fetch.ts`, `server/src/test-fetch.js`, `client/src/assets/react.svg`, `client/public/vite.svg`
- Modify: root/client/server `package.json`, `client/src/components/SettingsModal.tsx`, `client/src/components/MemoryManagerModal.tsx`, `server/src/services/MemoryService.ts`, `server/src/routes/sessionRoutes.ts`, `client/src/types.ts`, `client/src/lib/api.ts`, `.gitignore`
- Create: `LICENSE`, `.env.example`, `.editorconfig`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: IPC API from Task 4.
- Produces: clean repo, version `1.1.0`, credential entry via IPC in the current Settings modal.

- [ ] **Step 1: Remove dead files and notes feature**

Delete the files listed above. Remove `getNotes/addNote/updateNote/deleteNote` from `MemoryService`, the `/notes` routes, `Note` from `client/src/types.ts`, and notes methods from `client/src/lib/api.ts`. Remove the notes tab, `NotesManager` import, and its usage from `MemoryManagerModal.tsx` so the modal still builds until Task 24 replaces it. Remove the `notes` table creation from the legacy `db.ts` only after Task 8 replaces the DB; until then, stop reading/writing it.

- [ ] **Step 2: Set versions and metadata**

Set `"version": "1.1.0"` in root/client/server. Add `"engines": { "node": ">=20.18" }` and `"packageManager": "npm@10"` to root. Root scripts: `"test": "npm run test:server && npm run test:client"`, `"test:server": "npm --prefix server test"`, `"test:client": "npm --prefix client test"`, `"typecheck": "npm --prefix server run typecheck && npm --prefix client run build"`.

- [ ] **Step 3: Add license, env example, editor config, gitignore**

`LICENSE` uses ISC with `Copyright (c) 2026 Phuc`. `.env.example` documents `MORPHI_TOKEN`, `MORPHI_TITLE_MODEL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `PROXYPAL_URL`, and `PROXYPAL_API_KEY` without real values. `.gitignore` adds `build_log*`, `*.db`, `*.db-wal`, `*.db-shm`, `*.v1.bak`, `playwright-report/`, `test-results/`, `dist_electron/`, `.tmp/`.

- [ ] **Step 4: Switch current SettingsModal key save to IPC**

In `SettingsModal.tsx`, replace direct `localStorage` key reads with `window.morphi.credentials.status()` on open and `window.morphi.credentials.set/delete` on save/delete. Remove all `localStorage.getItem/setItem` calls containing API keys. In a dev browser without `window.morphi`, do not accept keys over HTTP (the spec forbids HTTP key intake); show `Cấu hình key cần app Electron. Trong dev, đặt GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / PROXYPAL_API_KEY trong .env.` and keep the inputs disabled. Server dev mode seeds those env keys into the credential holder in Task 17.

- [ ] **Step 5: Add CI skeleton**

`.github/workflows/ci.yml` runs on push/PR with a matrix `os: [windows-latest, ubuntu-latest]`, `node-version: 20.18`, `npm ci` in server/client, `npm run typecheck`, `npm test`, `npm run build`. Playwright is not in CI yet; it is added in Task 25/32.

- [ ] **Step 6: Verify build, tests, and clean status**

Run: `npm test && npm run build && npm run typecheck`.
Expected: all pass; `git status --short` shows only intended changes (no Morphi.exe, build logs, notes feature, or dead files).

- [ ] **Step 7: Commit checkpoint**

Suggested message: `chore: clean repo, align 1.1.0 metadata, and add CI skeleton`.

---

# Phase 2 — Core Harness

### Task 8: Database schema and legacy backup

**Files:**
- Create: `server/src/db/connection.ts`, `server/src/db/schema.ts`, `server/src/db/schema.test.ts`
- Test: `server/src/db/schema.test.ts`, helper `server/test/db.ts`

**Interfaces:**
- Consumes: none.
- Produces: `openDatabase(filePath: string): Database.Database`; `initializeSchema(db): void`; tables exactly as spec.

- [ ] **Step 1: Write failing schema test**

```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeSchema } from './schema';

describe('schema', () => {
  it('creates event-sourced tables without notes', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'sessions', 'session_events', 'provider_settings', 'schema_meta']));
    expect(tables).not.toContain('notes');
    expect(tables).not.toContain('messages');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd server && npx vitest run src/db/schema.test.ts`
Expected: FAIL because `schema.ts` does not exist.

- [ ] **Step 3: Implement schema and legacy backup**

`server/src/db/schema.ts` executes the spec schema plus `schema_version INTEGER NOT NULL DEFAULT 1` on `session_events`, and inserts `schema_meta` version `1`. `server/src/db/connection.ts` checks for a legacy `messages` table before opening normally; if found, closes the probe connection, renames `morphi.db` and its `-wal`/`-shm` sidecars to `.v1.bak`, then creates a fresh DB. Tests create a legacy DB in a temp directory, call `openDatabase`, assert the backup file exists, and assert the new DB is empty.

- [ ] **Step 4: Implement connection**

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initializeSchema } from './schema';

export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ':memory:' && fs.existsSync(filePath)) {
    const probe = new Database(filePath, { readonly: true });
    const legacy = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    probe.close();
    if (legacy) {
      const backup = `${filePath}.v1.bak`;
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(filePath + suffix)) fs.renameSync(filePath + suffix, backup + suffix);
      }
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd server && npx vitest run src/db/schema.test.ts`
Expected: PASS, including legacy backup test.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(db): add event-sourced schema and legacy database backup`.

---

### Task 9: Event store

**Files:**
- Create: `server/src/harness/shared/types.ts`, `server/src/harness/events/types.ts`, `server/src/harness/events/store.ts`, `server/src/harness/events/store.test.ts`, `server/test/db.ts`

**Interfaces:**
- Consumes: `openDatabase`, `initializeSchema`.
- Produces: `TokenUsage`, `JsonSchema`; `EventPayloadMap`, `SessionEvent`, `NewSessionEvent`, `EventStore.append(sessionId, events)`, `EventStore.list(sessionId, afterSeq?)`.

- [ ] **Step 1: Define shared types and event types**

`server/src/harness/shared/types.ts` (created before the LLM module so later tasks can import it):

```ts
export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number; }

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
}

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'waiting_approval' | 'cancelled';

export type LiveEvent =
  | { type: 'assistant/delta'; payload: { turnId: string; text: string } }
  | { type: 'thought/delta'; payload: { turnId: string; text: string } }
  | { type: 'tool/progress'; payload: { callId: string; message: string } }
  | { type: 'agent/status'; payload: { state: AgentStatus; turnId?: string } }
  | { type: 'mcp/status'; payload: { connected: boolean; studioLinked: boolean } }
  | { type: 'error'; payload: { code: string; message: string; retryable: boolean } };
```

`server/src/harness/events/types.ts`:

```ts
import type { LiveEvent, TokenUsage } from '../shared/types';

export type TurnTrigger = 'user' | 'steer' | 'goal' | 'workflow' | 'regenerate';
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled';

export interface EventPayloadMap {
  'session/created': { projectId: string; title: string; modelSelection?: string };
  'session/title': { title: string; source: 'auto' | 'user' };
  'session/skills': { skills: string[] };
  'turn/start': { turnId: string; modelSelection: string; trigger: TurnTrigger; regeneratedFrom?: { userMessageId: string; supersedesAssistantMessageId: string } };
  'step/start': { stepId: string; index: number };
  'user/message': { messageId: string; content: string; source: 'user' | 'steer' };
  'assistant/message': { messageId: string; content: string; reasoning?: string; finishReason: FinishReason; usage?: TokenUsage; callIds: string[] };
  'assistant/attempt': { attemptId: string; error: string; retryable: boolean; finishedAt: number };
  'tool/call': { callId: string; name: string; args: unknown; startedAt: number };
  'tool/result': { callId: string; status: 'done' | 'error' | 'cancelled'; result?: unknown; durationMs: number };
  'approval/request': { approvalId: string; callId: string; name: string; args: unknown; risk: 'low' | 'medium' | 'high' };
  'approval/decision': { approvalId: string; decision: 'allow' | 'deny' | 'expired'; scope: 'once' | 'session' };
  'compaction/summary': { summary: string; coveredFrom: number; coveredTo: number; tokenEstimate: number };
  'turn/end': { turnId: string; reason: 'completed' | 'cancelled' | 'max_steps' | 'error' };
  'goal/changed': { goalId: string; status: 'active' | 'done' | 'blocked'; objective: string };
  'subagent/start': { subagentId: string; parentSessionId: string; childSessionId: string; task: string };
  'subagent/end': { subagentId: string; status: 'done' | 'error' | 'cancelled'; summary: string };
  'workflow/start': { workflowId: string; name: string; phases: string[] };
  'workflow/phase': { workflowId: string; phase: string; status: 'started' | 'completed' | 'failed' };
  'workflow/end': { workflowId: string; status: 'completed' | 'failed' | 'cancelled' };
}

export type EventType = keyof EventPayloadMap;
export interface NewSessionEvent<T extends EventType = EventType> { type: T; payload: EventPayloadMap[T]; }
export interface SessionEvent<T extends EventType = EventType> {
  id: number; sessionId: string; seq: number; type: T; payload: EventPayloadMap[T]; schemaVersion: 1; createdAt: number;
}

export interface Emit {
  durable(event: SessionEvent): void;
  live(event: LiveEvent): void;
}
```

- [ ] **Step 2: Write failing event-store tests**

Test append assigns `seq` 1,2,3; `list(afterSeq)` filters; a failed second insert rolls back the whole batch; `sessions.last_updated` advances.

- [ ] **Step 3: Implement EventStore**

```ts
import type Database from 'better-sqlite3';
import type { NewSessionEvent, SessionEvent } from './types';

export class EventStore {
  constructor(private db: Database.Database) {}

  append(sessionId: string, events: NewSessionEvent[]): SessionEvent[] {
    const insert = this.db.prepare('INSERT INTO session_events (session_id, seq, type, payload, schema_version, created_at) VALUES (?, ?, ?, ?, 1, ?)');
    const update = this.db.prepare('UPDATE sessions SET last_updated = ? WHERE id = ?');
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?');
    return this.db.transaction(() => {
      const start = (next.get(sessionId) as { seq: number }).seq;
      const now = Date.now();
      const rows = events.map((event, index) => {
        const seq = start + index + 1;
        const result = insert.run(sessionId, seq, event.type, JSON.stringify(event.payload), now);
        return { id: Number(result.lastInsertRowid), sessionId, seq, type: event.type, payload: event.payload, schemaVersion: 1 as const, createdAt: now };
      });
      update.run(now, sessionId);
      return rows;
    })();
  }

  list(sessionId: string, afterSeq = 0): SessionEvent[] {
    const rows = this.db.prepare('SELECT id, session_id, seq, type, payload, schema_version, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC').all(sessionId, afterSeq) as any[];
    return rows.map((row) => ({ id: row.id, sessionId: row.session_id, seq: row.seq, type: row.type, payload: JSON.parse(row.payload), schemaVersion: row.schema_version, createdAt: row.created_at }));
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/events/store.test.ts`
Expected: PASS 4 tests.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `feat(harness): add append-only session event store`.

---

### Task 10: Projections for messages, steps, and regenerate

**Files:**
- Create: `server/src/harness/session/projections.ts`, `server/src/harness/session/projections.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`.
- Produces: `DerivedMessage`, `DerivedStep`, `DerivedToolCall`, `deriveMessages(events)`, `deriveSteps(events)`.

- [ ] **Step 1: Write failing projection tests**

Cover:
1. user + assistant text produce two messages.
2. `assistant/attempt` does not create a message.
3. `tool/call` and `tool/result` attach a completed call step to the assistant message.
4. `compaction/summary` hides messages inside `coveredFrom..coveredTo` and inserts one system message before later messages.
5. `turn/start.regeneratedFrom` hides the superseded assistant message while keeping the user message.

```ts
expect(deriveMessages(events).map((m) => [m.role, m.content])).toEqual([
  ['user', 'hello'],
  ['assistant', 'world'],
]);
expect(deriveMessages(events).find((m) => m.id === 'old')?.superseded ?? false).toBe(false);
```

- [ ] **Step 2: Implement projection**

```ts
export interface DerivedToolCall { callId: string; name: string; args: unknown; status: 'running' | 'done' | 'error' | 'cancelled'; result?: unknown; durationMs?: number; }
export interface DerivedApproval { approvalId: string; callId: string; name: string; args: unknown; risk: 'low' | 'medium' | 'high'; decision?: 'allow' | 'deny' | 'expired'; }
export type DerivedStep =
  | { type: 'text'; content: string }
  | { type: 'call'; call: DerivedToolCall }
  | { type: 'approval'; approval: DerivedApproval };
export interface DerivedMessage { id: string; role: 'user' | 'assistant' | 'system'; content: string; reasoning?: string; steps: DerivedStep[]; usage?: TokenUsage; createdAt: number; superseded: boolean; }

export function deriveMessages(events: SessionEvent[]): DerivedMessage[] {
  const messages: DerivedMessage[] = [];
  const calls = new Map<string, DerivedToolCall>();
  const approvals = new Map<string, DerivedApproval>();
  const superseded = new Set<string>();
  const seqById = new Map<string, number>();
  let current: DerivedMessage | undefined;

  for (const event of events) {
    if (event.type === 'turn/start' && event.payload.regeneratedFrom) {
      superseded.add(event.payload.regeneratedFrom.supersedesAssistantMessageId);
    } else if (event.type === 'user/message') {
      current = { id: event.payload.messageId, role: 'user', content: event.payload.content, steps: [], createdAt: event.createdAt, superseded: false };
      messages.push(current);
      seqById.set(current.id, event.seq);
    } else if (event.type === 'assistant/message') {
      current = { id: event.payload.messageId, role: 'assistant', content: event.payload.content, reasoning: event.payload.reasoning, usage: event.payload.usage, steps: event.payload.content ? [{ type: 'text', content: event.payload.content }] : [], createdAt: event.createdAt, superseded: false };
      messages.push(current);
      seqById.set(current.id, event.seq);
    } else if (event.type === 'tool/call') {
      const call: DerivedToolCall = { callId: event.payload.callId, name: event.payload.name, args: event.payload.args, status: 'running' };
      calls.set(call.callId, call);
      current?.steps.push({ type: 'call', call });
    } else if (event.type === 'tool/result') {
      const call = calls.get(event.payload.callId);
      if (call) { call.status = event.payload.status; call.result = event.payload.result; call.durationMs = event.payload.durationMs; }
    } else if (event.type === 'approval/request') {
      const approval: DerivedApproval = { ...event.payload };
      approvals.set(approval.approvalId, approval);
      current?.steps.push({ type: 'approval', approval });
    } else if (event.type === 'approval/decision') {
      const approval = approvals.get(event.payload.approvalId);
      if (approval) approval.decision = event.payload.decision;
    } else if (event.type === 'compaction/summary') {
      for (let index = messages.length - 1; index >= 0; index--) {
        const seq = seqById.get(messages[index].id);
        if (seq !== undefined && seq >= event.payload.coveredFrom && seq <= event.payload.coveredTo) {
          messages.splice(index, 1);
        }
      }
      const summary: DerivedMessage = { id: `summary_${event.seq}`, role: 'system', content: event.payload.summary, steps: [], createdAt: event.createdAt, superseded: false };
      const insertAt = messages.findIndex((message) => (seqById.get(message.id) ?? 0) > event.payload.coveredTo);
      if (insertAt === -1) messages.push(summary);
      else messages.splice(insertAt, 0, summary);
      seqById.set(summary.id, event.seq);
    }
  }

  for (const id of superseded) {
    const message = messages.find((m) => m.id === id);
    if (message) message.superseded = true;
  }
  return messages.filter((m) => !m.superseded);
}

export function deriveSteps(events: SessionEvent[]): DerivedStep[] {
  return deriveMessages(events).flatMap((message) => message.steps);
}
```

- [ ] **Step 3: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/session/projections.test.ts`
Expected: PASS 5 tests.

- [ ] **Step 4: Commit checkpoint**

Suggested message: `feat(harness): derive messages and steps from session events`.

---

### Task 11: Project and session stores with title service

**Files:**
- Create: `server/src/harness/session/store.ts`, `server/src/harness/session/title.ts`, tests `store.test.ts`, `title.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `deriveMessages`, `deriveSteps`.
- Produces: `ProjectRecord`, `SessionSummary`, `SessionDetail`, `ProjectStore`, `SessionStore` (including `updateModelSelection`), `TitleService`, `fallbackTitle(text)`.

- [ ] **Step 1: Write failing store tests**

Test:
1. `createProject` and `listProjects` return newest first.
2. `createSession` appends `session/created` and returns a summary without messages.
3. `list(projectId)` does not query messages, but `get(id)` returns `messages` and `steps`.
4. `rename` appends `session/title` and updates the row.
5. `get` returns `skills` from the latest `session/skills` event.

- [ ] **Step 2: Implement store interfaces**

```ts
export interface SessionSummary { id: string; projectId: string; projectName?: string; title: string; createdAt: number; lastUpdated: number; isPinned: boolean; status: string; modelSelection?: string; goalId?: string; }
export interface SessionDetail extends SessionSummary { messages: DerivedMessage[]; steps: DerivedStep[]; skills: string[]; }
```

`SessionStore.create(projectId, title, modelSelection?)` uses `createId('sess')`, inserts the row, and appends `session/created` in one `db.transaction`. `list(projectId?)` joins `projects` and selects only session columns. `get(id)` reads events once and derives. `updateModelSelection(id, selection)` updates the row so the composer reopens on the last model used. `rename(id, title, source: 'auto' | 'user' = 'user')` appends `session/title` and updates the row; the chat route calls it with `'auto'` after title generation.

- [ ] **Step 3: Implement title fallback and test**

```ts
export function fallbackTitle(text: string): string {
  const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean).slice(0, 5);
  return words.join(' ') || 'New conversation';
}

export class TitleService {
  constructor(private complete: (prompt: string, model: string) => Promise<string>, private model: string) {}
  async generate(firstMessage: string): Promise<string> {
    try {
      const raw = await this.complete(`Generate a concise 4-5 word title for: ${firstMessage}`, this.model);
      const title = raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
      if (title && title.length <= 60) return title;
    } catch { /* fall through to heuristic */ }
    return fallbackTitle(firstMessage);
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/session/store.test.ts src/harness/session/title.test.ts`
Expected: PASS all store and title tests.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `feat(harness): add project/session stores and title service`.

---

### Task 12: LLM seam and OpenAI-compatible adapter

**Files:**
- Create: `server/src/harness/llm/types.ts`, `server/src/harness/llm/sse.ts`, `server/src/harness/llm/openaiCompatible.ts`, tests `sse.test.ts`, `openaiCompatible.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `ToolSchema`, `LlmMessage`, `LlmRequest`, `StreamEvent`, `ModelInfo`, `ProviderAdapter`, `OpenAICompatibleAdapter`.

- [ ] **Step 1: Define shared LLM types**

```ts
import type { JsonSchema, TokenUsage } from '../shared/types';

export interface ToolSchema { name: string; description: string; parameters: JsonSchema; }
export interface LlmToolCall { id: string; name: string; args: unknown; }
export interface LlmMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: LlmToolCall[]; reasoning?: string; }
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; callId: string; name: string }
  | { type: 'tool_call_delta'; callId: string; argsDelta: string }
  | { type: 'tool_call_end'; callId: string; name: string; args: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled' }
  | { type: 'error'; error: { code: string; message: string; retryable: boolean; status?: number } };
export interface LlmRequest { model: string; messages: LlmMessage[]; tools: ToolSchema[]; thinking?: boolean; signal: AbortSignal; }
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  setApiKey?(apiKey: string): void;
  setBaseUrl?(baseUrl: string): void;
  listModels(): Promise<ModelInfo[]>;
  stream(request: LlmRequest): AsyncIterable<StreamEvent>;
}
export interface ModelInfo { id: string; name: string; provider: string; providerLabel: string; context?: number; supportsTools: boolean; }
```

- [ ] **Step 2: Write failing SSE and adapter tests**

Test SSE chunk splitting, text deltas, reasoning, tool-call accumulation (start/delta/end with parsed args), 429 error retryable, and abort. Use `vi.stubGlobal('fetch', ...)` returning a `Response` with a `ReadableStream`.

- [ ] **Step 3: Implement server SSE parser**

```ts
export function parseSSEChunk(buffer: string, chunk: string, flush = false): { data: string[]; rest: string } {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  const rest = flush ? '' : lines.pop() || '';
  const data = lines.map((line) => line.trim()).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (flush) {
    const tail = combined.trim();
    if (tail.startsWith('data:')) data.push(tail.slice(5).trim());
  }
  return { data, rest };
}
```

- [ ] **Step 4: Implement OpenAI-compatible adapter**

The adapter builds `POST ${baseUrl}/chat/completions` with `stream: true`, maps `messages` and `tools`, and parses deltas. `listModels()` calls `GET ${baseUrl}/models` with the bearer key, maps ids/context to `ModelInfo`, and sets `supportsTools: false` for ids containing `embed`, `whisper`, `tts`, `dall-e`, or `image`; all other chat ids are `true` (OpenAI-compatible endpoints do not expose a reliable tool capability field). The constructor takes `{ id, name, baseUrl, defaultHeaders? }` and `setBaseUrl` replaces the stored base URL. Accumulate tool calls by index; on `finish_reason` or `[DONE]`, emit `tool_call_end` for each accumulated call and then `finish`. Map HTTP 429/5xx to retryable error events; 4xx to non-retryable. Respect `request.signal` by checking `signal.aborted` before each yield and passing it to `fetch`.

- [ ] **Step 5: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/llm/sse.test.ts src/harness/llm/openaiCompatible.test.ts`
Expected: PASS parser and adapter tests.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(llm): add normalized streaming seam and OpenAI-compatible adapter`.

---

### Task 13: Gemini adapter and LLM registry

**Files:**
- Create: `server/src/harness/llm/gemini.ts`, `server/src/harness/llm/registry.ts`, tests `gemini.test.ts`, `registry.test.ts`

**Interfaces:**
- Consumes: Task 12 types.
- Produces: `GeminiAdapter`; `LlmRegistry.setCredentials(keys)`, `setProviderConfig(id, config)`, `addCustomProvider(providerId, baseUrl)`, `refreshModels()`, `getModels()`, `resolveAuto(lastModel?)`, `complete(prompt, modelSelection): Promise<string>`, `providerStatus()`.

- [ ] **Step 1: Write failing Gemini test**

Fake SSE lines with text, thought, functionCall, `usageMetadata`, and `finishReason`. Expect `text_delta`, `reasoning_delta`, `tool_call_end` with `{ location: 'Workspace' }`, `usage`, `finish`.

- [ ] **Step 2: Implement Gemini adapter**

POST `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}` with `systemInstruction`, `contents`, `tools: [{ functionDeclarations }]`, `generationConfig`. Parse each `data:` JSON; for each part emit text/thought; for `functionCall` emit `tool_call_start` then `tool_call_end` with a generated `callId`; map `usageMetadata.promptTokenCount/candidatesTokenCount/totalTokenCount`; map `finishReason`. Implement `listModels()` with `GET https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, keep entries whose `supportedGenerationMethods` include `generateContent`, and map `inputTokenLimit` to `context`; models whose name starts with `gemini-` are marked `supportsTools: true`.

- [ ] **Step 3: Write failing registry test**

Adapters: fake OpenAI-compatible with models `gpt-4o` and `gpt-4o-mini`, fake Gemini with `gemini-2.0-flash`. Expect `resolveAuto()` picks Google before OpenAI, then largest context model with `supportsTools`. Expect last selected model wins when still usable.

- [ ] **Step 4: Implement registry**

Priority map `google: 0, openai: 1, openrouter: 2, proxypal: 3, custom: 4`, overridable by `constructor(adapters, priority = [...])` from `settings.json`. `setProviderConfig(id, config)` calls `adapter.setBaseUrl` when present and records `enabled`. `addCustomProvider(providerId, baseUrl)` accepts only `/^custom:[a-z0-9-]+$/`, creates an `OpenAICompatibleAdapter` with that id/baseUrl, and makes it usable after a key arrives via `setCredentials`. `setCredentials` calls `adapter.setApiKey` and clears keys for adapters absent from the map so deleting a credential disables that provider; in dev, Task 17 seeds it from `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `PROXYPAL_API_KEY`. `refreshModels` calls each enabled adapter's `listModels`; failures are logged and skipped. `resolveAuto` returns the last model if present, else the first priority provider with a tool-capable model, sorted by context descending. `complete` resolves the adapter from `modelSelection` (or `resolveAuto`), concatenates text deltas, and throws on an error event; `TitleService` depends on it. `providerStatus()` returns `{ providerId, configured, enabled }[]` derived from adapter keys and provider settings, including `custom:*` entries.

- [ ] **Step 5: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/llm/gemini.test.ts src/harness/llm/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(llm): add Gemini adapter and auto model resolution`.

---

### Task 14: Tool registry, approval, pipeline, and built-ins

**Files:**
- Create: `server/src/harness/tools/types.ts`, `registry.ts`, `approval.ts`, `pipeline.ts`, `builtin/todo.ts`, `builtin/lint.ts`
- Tests: `registry.test.ts`, `approval.test.ts`, `pipeline.test.ts`, `builtin.test.ts`
- Modify: `server/package.json` (add `ajv`)

**Interfaces:**
- Consumes: `EventStore`, `Emit`, `ToolSchema`.
- Produces: `ToolDefinition`, `ToolRegistry`, `ApprovalService`, `McpGateway` contract, `ToolPipeline.run(calls, context)`.

- [ ] **Step 1: Define tool types**

```ts
export interface ToolContext { sessionId: string; turnId: string; stepId: string; callId: string; signal: AbortSignal; emit: Emit; mcp: McpGateway; }

export interface McpGateway {
  readonly connected: boolean;
  readonly studioLinked: boolean;
  listTools(): Promise<ToolSchema[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  reconnect(): Promise<void>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
  timeoutMs?: number;
  isConcurrencySafe: boolean;
  approval: 'auto' | 'ask' | 'ask-once';
  presentation: { label: string; risk: 'low' | 'medium' | 'high' };
}
```

- [ ] **Step 2: Write failing approval tests**

Test `auto` resolves allow immediately; `ask` waits for `decide`; timeout resolves `expired`; `ask-once` auto-allows the second call in the same session after a session-scoped allow; high risk always requests even when session-approved.

- [ ] **Step 3: Implement ApprovalService**

`request(input, emit)` creates an `approvalId`, calls `emit.durable({ type: 'approval/request', ... })`, emits live `agent/status waiting_approval`, stores the resolver plus that `emit`, and starts a 120s timer. `decide(id, decision, scope)` uses the stored `emit` to append and stream `approval/decision`, resolves, and adds a session approval for allow+session. `expired` is recorded as `decision: 'expired', scope: 'once'`. This keeps the approval modal driven by the open SSE stream instead of requiring a reload.

- [ ] **Step 4: Implement pipeline**

`run(calls, context)`:
1. Emit `tool/call` per call through `context.emit.durable`.
2. For each call, validate args with AJV against the tool schema; invalid args emit `tool/result` status `error`.
3. Resolve approval through `ApprovalService.request(input, context.emit)`; deny emits `tool/result` status `error` with `{ error: 'APPROVAL_DENIED' }`.
4. Run serial tools in order with a barrier; run concurrency-safe tools in a pool of 4.
5. Abort/timeout emits `tool/result` status `cancelled`.
6. Truncate `String(result)` to 50,000 chars.

Default tool timeout is 60s; MCP tools use 120s. The registry is built per turn: built-ins plus merged MCP tools, and `schemas()` exposes only name/description/parameters to the model.

- [ ] **Step 5: Add built-ins and MCP merge**

`todo_write` validates `{ todos: { title: string; status: 'todo'|'doing'|'done' }[] }`, returns `{ todos }`, approval `auto`, concurrency safe. `lint_luau` runs the existing basic checks (deprecated `wait`, missing `local`, block mismatch), returns `{ issues: string[] }`, approval `auto`, concurrency safe.

`ToolRegistry.syncMcp(gateway)` converts each MCP tool into a `ToolDefinition` with the original name, `approval: 'ask'` (or `ask-once` when the name matches read prefixes), `isConcurrencySafe: false`, `timeoutMs: 120000`, and `execute` delegating to `gateway.callTool`. Task 17 calls it when the registry is created and after reconnect.

- [ ] **Step 6: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/tools`
Expected: PASS all tool tests, including concurrency barrier and truncation.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(harness): add tool registry, approval policy, and pipeline`.

---

### Task 15: Prompt assembly and compaction

**Files:**
- Create: `server/src/harness/prompt/assemble.ts`, `sections.ts`, `server/src/harness/compaction/estimator.ts`, `pruner.ts`, `summarizer.ts`, `service.ts`
- Tests: `server/src/harness/prompt/assemble.test.ts`, `server/src/harness/compaction/compaction.test.ts`

**Interfaces:**
- Consumes: `ToolSchema`, `LlmMessage`, `SessionEvent`.
- Produces: `assembleSystemPrompt(input)`, `estimateTokens(messages)`, `pruneMessages(messages, keepTurns)`, `CompactionService` constructed with `{ events, complete, model, config }` and `buildContext(sessionId): Promise<LlmMessage[]>`.

- [ ] **Step 1: Write failing prompt tests**

Assert section order identity → safety → environment → tool policy → runtime → skills → instructions; assert tool names come from the supplied schemas, not a hardcoded list; assert `goal` is included when provided.

- [ ] **Step 2: Implement prompt assembly**

```ts
export function assembleSystemPrompt(input: PromptInput): string {
  const sections = [
    sections.identity(),
    sections.safety(),
    sections.environment(input.environment),
    sections.toolPolicy(input.tools),
    sections.runtime(input.runtime),
    input.skills.length ? sections.skills(input.skills) : '',
    input.instructions ? sections.instructions(input.instructions) : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}
```

`toolPolicy` lists schema names and descriptions and states approval semantics; `identity` says Morphi is a Roblox Luau architect; `safety` covers Luau style and no globals.

- [ ] **Step 3: Write failing compaction tests**

Test estimator `chars / 4`; prune replaces old tool results with `[tool result omitted: N chars]` without mutating inputs; summarize fallback truncates to 1024 chars when `complete` throws; summary event is appended with covered seq range.

- [ ] **Step 4: Implement compaction**

`pruneMessages` keeps the last `keepTurns` turns and replaces older `role: 'tool'` content. `CompactionService.buildContext(sessionId)` reads events through the injected `EventStore`, converts derived tool-call steps into assistant `toolCalls` plus `role: 'tool'` messages (using `callId` and JSON-stringified results), estimates tokens, prunes at 70%, and when at 85% calls `complete` to summarize all but the last 6 turns, appends `compaction/summary` through the store, and returns a system message followed by recent messages. Existing `compaction/summary` events form the summarized prefix: only events after the latest `coveredTo` are eligible, and no summary is appended when that range is empty. Original source events are never updated or deleted.

- [ ] **Step 5: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/prompt src/harness/compaction`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(harness): add prompt assembly and context compaction`.

---

### Task 16: Agent loop with retry, cancellation, inbox, and limits

**Files:**
- Create: `server/src/harness/agent/loop.ts`, `inbox.ts`, `retry.ts`, tests `loop.test.ts`, `inbox.test.ts`, `retry.test.ts`
- Modify: `server/src/harness/agent/cancellation.ts` (reuse)

**Interfaces:**
- Consumes: `EventStore`, `LlmRegistry`, `ToolRegistry`, `ToolPipeline`, `CompactionService`, `assembleSystemPrompt`.
- Produces: `AgentLoop` constructed with `{ events: EventStore; llm: LlmRegistry; tools: ToolRegistry; pipeline: ToolPipeline; compaction: CompactionService; inbox: Inbox }`; `AgentLoop.runTurn(input, emit): Promise<TurnResult>`; `Inbox.push(sessionId, content)`, `Inbox.drain(sessionId)`.

- [ ] **Step 1: Define loop types and write failing test**

`loop.ts` exports the shared contract used by routes and the client:

```ts
import type { AgentStatus } from '../shared/types';
import type { Emit, TurnTrigger } from '../events/types';

export interface AgentTurnInput {
  sessionId: string;
  content?: string;
  modelSelection: string;
  trigger: TurnTrigger;
  thinking?: boolean;
  signal: AbortSignal;
  regeneratedFrom?: { userMessageId: string; supersedesAssistantMessageId: string };
}

export interface TurnResult {
  turnId: string;
  status: 'completed' | 'cancelled' | 'max_steps' | 'error';
}
```

Test a scripted adapter returning `text_delta('hi')` then `finish('stop')`; expect durable events `turn/start`, `user/message`, `step/start`, `assistant/message`, `turn/end completed`, and live `assistant/delta` + `agent/status`.

- [ ] **Step 2: Implement loop skeleton**

```ts
async runTurn(input: AgentTurnInput, emit: Emit): Promise<TurnResult> {
  const turnId = createId('turn');
  emit.durable(this.events.append(input.sessionId, [{ type: 'turn/start', payload: { turnId, modelSelection: input.modelSelection, trigger: input.trigger || 'user', regeneratedFrom: input.regeneratedFrom } }])[0]);
  if (input.content) emit.durable(this.events.append(input.sessionId, [{ type: 'user/message', payload: { messageId: createId('msg'), content: input.content, source: 'user' } }])[0]);
  // step loop follows in Step 3
  return { turnId, status: 'completed' };
}
```

- [ ] **Step 3: Implement step loop**

For up to 24 steps: append `step/start`; build messages from `buildContext` (it derives the just-appended `user/message` from the event log, so do not append it twice); call `assembleSystemPrompt` with `tools.schemas()` and pass those same schemas to the provider request; stream provider events and emit live deltas; collect text, reasoning, usage, and tool calls; append `assistant/message`; if tool calls exist, call `pipeline.run(calls, { ...context, emit })` (the pipeline emits `tool/call`/`tool/result` and approval events) and continue; otherwise append `turn/end completed` and stop. If step 24 still returns tool calls, append `turn/end` with reason `max_steps` instead of starting another step. Enforce 8 tool calls per step, 10-minute turn timeout, and abort checks before every event. Emit `agent/status thinking` at turn start, `tool` around tool batches, and `idle` at the end. A timeout appends `turn/end` with reason `error` and emits live `error` code `TURN_TIMEOUT`.

- [ ] **Step 4: Implement retry**

`runWithRetry` retries retryable errors 3 times with 500/1500/4000ms delays, appends `assistant/attempt` for each failed attempt, and never retries 4xx. If exhausted, append `turn/end error` and emit `error`.

- [ ] **Step 5: Implement inbox and cancellation**

`Inbox` stores queued messages per session; `drain(sessionId)` returns messages at a step boundary. `AgentLoop` drains the inbox at the start of every step after the first, appends each queued item as a `user/message` with `source: 'steer'`, and lets the next `buildContext` include it. On abort, stop the provider iterator, cancel running tools through the pipeline signal, append `turn/end cancelled`, emit `agent/status idle`.

- [ ] **Step 6: Run tests — expect pass**

Run: `cd server && npx vitest run src/harness/agent`
Expected: PASS text turn, tool turn, retry, cancel, max steps, inbox.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(harness): add agent loop with retry and cancellation`.

---

### Task 17: Harness composition and non-chat routes

**Files:**
- Create: `server/src/harness/harness.ts`, `server/src/harness/llm/settings.ts`, `server/src/harness/mcp/serviceGateway.ts`, `server/src/routes/projects.ts`, `sessions.ts`, `providers.ts`, `models.ts`, `tools.ts`, `mcp.ts`, `memory.ts`, `index.ts`, `server/src/http/validation.ts`
- Modify: `server/src/index.ts`, `server/src/app.ts` (only if the mount hook needs adjustment)
- Delete after the new routes are mounted: `server/src/routes/chatRoutes.ts`, `modelRoutes.ts`, `projectRoutes.ts`, `sessionRoutes.ts`, `server/src/providers/**`, `server/src/services/LLMManager.ts`, `ModelRegistry.ts`, `SystemPrompt.ts`, `MemoryService.ts`, `server/src/types/llm.ts`, `server/src/db.ts`, `server/src/credentials.ts` (replaced by `LlmRegistry.setCredentials`)
- Keep until Task 31: `server/src/services/McpService.ts`
- Test: `server/src/routes/routes.test.ts`

**Interfaces:**
- Consumes: all prior harness modules; `createApp({ mount })` from Task 2.
- Produces: `createHarness(deps): Harness`; `ProviderSettingsStore`; route factories that accept `Harness`; `McpGateway` implementation contract from Task 14; a fully wired `server/src/index.ts`.

- [ ] **Step 1: Define composition root**

```ts
import type { ProviderSettingsStore } from './llm/settings';
export type { ProviderSettingsStore } from './llm/settings';

export interface MemoryStats { projects: number; sessions: number; events: number; approxBytes: number; legacyBackup?: string; }

export interface Harness {
  events: EventStore;
  projects: ProjectStore;
  sessions: SessionStore;
  llm: LlmRegistry;
  providerSettings: ProviderSettingsStore;
  titles: TitleService;
  tools: ToolRegistry;
  approvals: ApprovalService;
  pipeline: ToolPipeline;
  agent: AgentLoop;
  inbox: Inbox;
  mcp: McpGateway;
  cancellations: CancellationRegistry;
  memory: { stats(): MemoryStats; clear(): void };
}
export function createHarness(deps: { db: Database.Database; llm: LlmRegistry; mcp: McpGateway; titleModel: string; providerSettings: ProviderSettingsStore; compaction: { pruneAt: number; summarizeAt: number; keepRecentTurns: number } }): Harness;
```

`ProviderSettingsStore` is declared in `server/src/harness/llm/settings.ts` and re-exported by `harness.ts` to avoid a runtime cycle. It reads/writes the `provider_settings` table created in Task 8; `setConfig` upserts `updated_at`. `createHarness` wires `TitleService` with `llm.complete`, constructs the shared `Inbox` and `CancellationRegistry`, and calls `tools.syncMcp(mcp)`; the MCP reconnect route calls it again after reconnecting.

- [ ] **Step 2: Implement routes**

Projects: list/create/delete. Sessions: summary list with optional `projectId`, create, get detail, pin, delete, events replay. Providers: list status (built-ins plus `custom:*` rows), update `{ baseUrl, enabled }` only; for a new `custom:<slug>` id the route upserts the row and calls `llm.addCustomProvider`, then `refreshModels`. `GET /api/models?usable=true` returns `llm.getModels()` (empty when no provider is configured). Tools: metadata and session toggle. MCP: status/reconnect. Memory: stats/clear; stats sets `legacyBackup` when `<dbPath>.v1.bak` exists. All inputs validated with zod; all responses use camelCase. `PUT /api/providers/:id/config` uses a strict zod schema; an `apiKey` field must produce 400.

- [ ] **Step 3: Wire `server/src/index.ts`**

Replace the bootstrap with the full composition. Mount all routers through the `mount` hook so they sit behind the token middleware, and keep the `parentPort` credential handler from Task 4:

```ts
import { createServer } from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config';
import { openDatabase } from './db/connection';
import { createApp } from './app';
import { createHarness } from './harness/harness';
import { LlmRegistry } from './harness/llm/registry';
import { GeminiAdapter } from './harness/llm/gemini';
import { OpenAICompatibleAdapter } from './harness/llm/openaiCompatible';
import { createProviderSettingsStore } from './harness/llm/settings';
import { createMcpGateway } from './harness/mcp/serviceGateway';
import { McpService } from './services/McpService';
import { mountRoutes } from './routes';

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });
const config = loadConfig();
const db = openDatabase(config.dbPath);
const mcp = createMcpGateway(new McpService());
const registry = new LlmRegistry([
  new GeminiAdapter(),
  new OpenAICompatibleAdapter({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }),
  new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }),
  new OpenAICompatibleAdapter({ id: 'proxypal', name: 'ProxyPal', baseUrl: process.env.PROXYPAL_URL || 'http://localhost:8317/v1' }),
], config.autoPriority);
const envKeys = {
  google: process.env.GEMINI_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  proxypal: process.env.PROXYPAL_API_KEY,
};
registry.setCredentials(Object.fromEntries(Object.entries(envKeys).filter(([, value]) => Boolean(value))) as Record<string, string>);
const providerSettings = createProviderSettingsStore(db);
const harness = createHarness({ db, llm: registry, mcp, titleModel: config.titleModel, providerSettings, compaction: config.compaction });
for (const setting of providerSettings.list()) {
  if (setting.providerId.startsWith('custom:') && setting.baseUrl) {
    registry.addCustomProvider(setting.providerId, setting.baseUrl);
  }
  registry.setProviderConfig(setting.providerId, setting);
}

const app = createApp({
  token: config.token,
  version: '1.1.0',
  staticDir: config.clientDistPath,
  mount: (expressApp) => mountRoutes(expressApp, harness),
});
const server = createServer(app);
const parentPort = (process as unknown as { parentPort?: { on: Function; postMessage: Function } }).parentPort;

parentPort?.on('message', (message: any) => {
  if (message?.type === 'credentials') {
    registry.setCredentials(message.keys ?? {});
    void registry.refreshModels();
  }
});

server.listen(config.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  parentPort?.postMessage({ type: 'ready', port });
  console.log(`Morphi server listening on http://127.0.0.1:${port}`);
  void registry.refreshModels();
});
```

Create `server/src/routes/index.ts` exporting `mountRoutes(app, harness)`; it registers every router from this task plus the chat/approvals/skills/goals/workflows routers added in later tasks. Until those tasks land, mount the routers that exist.

Add the all-provider `complete` path to `LlmRegistry` in Task 13: it resolves the adapter from `modelSelection` or `resolveAuto`, concatenates text deltas, and throws on an error event. The registry also calls `providerSettings.setConfig`-loaded base URLs when constructing adapters; in 1.1.0 the four built-in base URLs are fixed and a future custom connector reads `baseUrl` here.

- [ ] **Step 4: Delete legacy modules**

Once `mountRoutes` serves the new endpoints and the integration tests pass, delete the legacy files listed above. Rewrite `server/src/index.ts` in the same change so nothing imports them. `serviceGateway.ts` wraps the legacy `McpService` behind `McpGateway`; Task 31 replaces the internals without changing the interface. Remove `cors` and the 50MB JSON limit with the old `index.ts`. Remove now-unused `cors`, `openai`, `@google/generative-ai`, and `@google-cloud/vertexai` entries from the root and server `package.json` after confirming no import remains; the harness talks to providers over `fetch`.

- [ ] **Step 5: Write route integration tests**

Use supertest with a test DB, fake LLM adapter, stub MCP. Assert 401 without token, project/session CRUD, summary list has no `messages`, detail has derived messages, provider config rejects `apiKey` in body, and memory stats reflect created rows.

- [ ] **Step 6: Run tests — expect pass**

Run: `cd server && npx vitest run src/routes/routes.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(server): compose harness and add data/provider/tool routes`.

---

### Task 18: Chat SSE, cancel, regenerate, approvals

**Files:**
- Create: `server/src/routes/chat.ts`, `server/src/routes/approvals.ts`, `server/src/http/sse.ts`
- Modify: `server/src/routes/index.ts` (register chat and approvals)
- Test: `server/src/routes/chat.test.ts`

**Interfaces:**
- Consumes: `Harness`, `AgentLoop`, `CancellationRegistry`, `TitleService`.
- Produces: SSE envelope writer; `POST /api/chat/stream`, `/cancel`, `/regenerate`; `POST /api/approvals/:id`.

- [ ] **Step 1: Define SSE envelope writer**

```ts
export function writeSSE(res: Response, event: { seq?: number; type: string; payload: unknown; id?: string }) {
  res.write(`data: ${JSON.stringify({ id: event.id || createId('evt'), seq: event.seq, type: event.type, payload: event.payload, ts: Date.now() })}\n\n`);
}
```

For a durable `SessionEvent`, call `writeSSE(res, { id: `evt_${event.id}`, seq: event.seq, type: event.type, payload: event.payload })`; live `LiveEvent`s get a generated `evt_` id and no `seq`.

- [ ] **Step 2: Implement stream route**

Validate `{ sessionId, message, model?, thinking? }`. If `harness.cancellations.has(sessionId)`, push the message into `harness.inbox` and return `202 { queued: true }` without opening SSE; the running turn drains it at the next step boundary. Otherwise write SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`); create a cancellation controller via `harness.cancellations.start(sessionId)`; abort that controller on `req.on('close')` when the response ends before `turn/end`; persist `model` on the session row via `sessions.updateModelSelection`; call `agent.runTurn` with `emit.durable` and `emit.live` both writing SSE (guard every write with `res.writableEnded` so a closed stream never crashes the turn); end with `turn/end`; on pre-stream failures return 4xx JSON; release the registry in `finally`. The route must not store a duplicate user message. When the session title is still the default, run `titles.generate(message)` without blocking the stream, append `session/title` via `sessions.rename(sessionId, title, 'auto')`, and write it to SSE only if the response is still open; otherwise the client refreshes the session list after `turn/end`. Emit `agent/status` transitions through the agent's live events; send a `: ping` comment every 15s.

- [ ] **Step 3: Implement cancel and regenerate**

`POST /cancel` aborts the registry entry. `POST /regenerate` accepts `{ sessionId, assistantMessageId }`; find the user message before that assistant in derived messages; call `runTurn` with `trigger: 'regenerate'` and `regeneratedFrom: { userMessageId, supersedesAssistantMessageId }`; do not append a new user message.

- [ ] **Step 4: Implement approvals**

`POST /api/approvals/:id` validates `{ decision: 'allow'|'deny', scope: 'once'|'session' }`, calls `approvals.decide`, and returns 404 for unknown ids.

- [ ] **Step 5: Write integration tests**

Use a scripted fake adapter:
1. text stream ends with `turn/end completed`.
2. tool call with `ask` waits; POST approval allow; tool result and next assistant message appear.
3. cancel mid-stream emits `turn/end cancelled`.
4. regenerate hides old assistant message and does not duplicate the user message.
5. error before stream returns 400/500 JSON; error mid-stream emits `error` + `turn/end`.

- [ ] **Step 6: Run tests — expect pass**

Run: `cd server && npx vitest run src/routes/chat.test.ts`
Expected: PASS all 5 scenarios.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(server): add SSE chat, cancel, regenerate, and approval routes`.

---

### Task 19: Client harness integration

**Files:**
- Create: `client/src/lib/chatReducer.ts`, `client/src/lib/chatReducer.test.ts`
- Modify: `client/src/types.ts`, `client/src/lib/api.ts`, `client/src/components/ChatInterface.tsx`, `client/src/components/Message.tsx` (temporary prop bridge until Task 23 replaces it)
- Test: `client/src/lib/chatReducer.test.ts`

**Interfaces:**
- Consumes: SSE envelope, `SessionSummary`, `SessionDetail`.
- Produces: `applyStreamEvent(state, event)`, new `api` methods, current UI wired to the harness.

- [ ] **Step 1: Update client types**

Mirror `SessionSummary`, `SessionDetail`, `DerivedMessage`, `DerivedStep`, `DerivedToolCall`, `DerivedApproval`, `ApprovalRequest`, `AgentStatus`, `ProviderStatus`, `ModelInfo`, `McpStatus`, `StreamEnvelope`. Remove `Note` and legacy `calls/steps` shapes.

- [ ] **Step 2: Write failing reducer test**

```ts
const state = applyStreamEvent(initialChatState, {
  id: 'e1', type: 'assistant/delta', payload: { turnId: 't1', text: 'Hello' }, ts: 1,
});
expect(state.draft.content).toBe('Hello');
```

Also test `thought/delta`, `error`, `agent/status`, and `turn/end`.

- [ ] **Step 3: Implement reducer**

Keep `messages` (durable), `draft` (assistant streaming), `status`, `pendingApproval`, and `error`. `user/message` appends only if the id is unseen; ChatInterface must not optimistically add a user bubble, so the server event is the single source. `assistant/delta` appends text to `draft`; `thought/delta` appends reasoning; `assistant/message` pushes the durable assistant message (or replaces a matching draft) and clears the draft; `tool/call`/`tool/result` attach to the latest assistant message's steps; `approval/request` sets `pendingApproval` and `approval/decision` clears it; `session/title` updates the sidebar title; `turn/end` clears the draft, sets idle, and leaves all durable messages in place; `error` sets a structured error.

- [ ] **Step 4: Rewrite api methods**

Implement `api.sessions.list/create/get/delete/pin`, `api.chat.stream/cancel/regenerate`, `api.approvals.decide`, `api.providers.list/updateConfig`, `api.models.list`, `api.tools.list/toggle`, `api.mcp.status/reconnect`, `api.memory.stats/clear`. Keep `request` and token header. `streamChat` now parses envelopes and dispatches to the reducer.

- [ ] **Step 5: Update ChatInterface**

Use `SessionSummary` for the sidebar (no full messages), fetch `SessionDetail` only when opening a session, use the reducer for streaming, pass `thought`/`steps` to `Message`, call `api.chat.cancel` on stop, and call `api.chat.regenerate` for regenerate. Fix the first-message flow again so no stale IDs remain.

- [ ] **Step 6: Run client tests and manual chat**

Run: `cd client && npm test -- --run src/lib/chatReducer.test.ts`.
Expected: PASS.
Manual: with a fake LLM adapter, send a message, see streamed text, stop, regenerate, reload session; confirm no duplicate user messages and thinking/tool steps render.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(client): consume event-sourced chat API and stream envelope`.

---

# Phase 3 — UI ChatGPT Desktop

### Task 20: Design tokens, i18n, client test setup, AppShell and Rail

**Files:**
- Modify: `client/src/index.css`, `client/src/App.tsx`, `client/index.html`, `client/package.json`
- Create: `client/src/i18n/vi.ts`, `client/src/components/layout/AppShell.tsx`, `Rail.tsx`, `client/src/test/setup.ts`, `client/vitest.config.ts` (replace node config with jsdom), `client/src/components/layout/AppShell.test.tsx`

**Interfaces:**
- Consumes: none.
- Produces: `vi` string dictionary; `AppShell` layout with rail/sidebar/main slots; test setup for React.

- [ ] **Step 1: Install test dependencies**

Run: `cd client && npm install -D @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react`.

- [ ] **Step 2: Write failing AppShell test**

Render `<AppShell rail={...} sidebar={...}>main</AppShell>` and assert the `main` landmark and Vietnamese labels `Trò chuyện`, `Dự án`, `Bộ nhớ`, `Studio`, `Cài đặt`.

- [ ] **Step 3: Replace design tokens**

In `client/src/index.css`, remove glassmorphism-heavy utilities; define exact tokens from the spec:

```css
:root {
  --bg-main: #ffffff;
  --bg-sidebar: #f9f9f9;
  --bg-card: #ffffff;
  --border-color: #ececec;
  --text-primary: #0d0d0d;
  --text-secondary: #5d5d5d;
  --accent: #10a37f;
}
.dark {
  --bg-main: #212121;
  --bg-sidebar: #171717;
  --bg-card: #2f2f2f;
  --border-color: #383838;
  --text-primary: #ececec;
  --text-secondary: #b4b4b4;
}
```

Add `@theme` mappings, 15px body, 13px sidebar, 32px welcome, 8/12/16/24px radii, 150–200ms motion, `prefers-reduced-motion` overrides, focus-visible ring.

Set `client/index.html` to `lang="vi"`, title `Morphi Intelligence`, and an inline SVG favicon using the accent color (remove the Vite asset).

- [ ] **Step 4: Add i18n dictionary**

`client/src/i18n/vi.ts` exports `vi` with keys for navigation, welcome, composer, statuses, settings, errors, approval, goals, workflows, skills, and confirmations. All new components read from `vi`; no hardcoded English.

- [ ] **Step 5: Implement AppShell and Rail**

`AppShell` is a flex row: `Rail` 56px, sidebar slot 260px, main slot flex. Rail buttons use Lucide icons and call `onNavigate`; active state uses accent; tooltips use Vietnamese labels. Below 1024px the sidebar becomes an overlay; below 768px main uses full width.

- [ ] **Step 6: Run UI tests and browser check**

Run: `cd client && npm test -- --run src/components/layout/AppShell.test.tsx`.
Expected: PASS.
Run: `npm run dev`, open the browser, verify rail icons, tooltips, light/dark tokens, focus rings, and no console errors at 1440/1024/768 widths.

- [ ] **Step 7: Commit checkpoint**

Suggested message: `feat(ui): add ChatGPT desktop tokens, Vietnamese copy, and app shell`.

---

### Task 21: Sidebar, recents grouping, and search palette

**Files:**
- Create: `client/src/lib/sessionGroups.ts`, `client/src/lib/sessionGroups.test.ts`, `client/src/components/layout/Sidebar.tsx`, `SearchPalette.tsx`, `Sidebar.test.tsx`
- Modify: `client/src/components/ChatInterface.tsx`, `client/src/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `SessionSummary[]`, `Project[]`.
- Produces: `groupSessionsByTime(sessions, now): { label; sessions }[]`; sidebar events `onSelectProject`, `onSelectSession`, `onNewSession`, `onNewProject`, `onDelete`, `onTogglePin`, `onSearch`.

- [ ] **Step 1: Write failing grouping test**

Use fixed `now = 2026-11-02T12:00:00Z`; sessions for today, yesterday, 3 days ago, 10 days ago; expect labels `Hôm nay`, `Hôm qua`, `7 ngày qua`, `Cũ hơn`.

- [ ] **Step 2: Implement grouping**

Compare local calendar days; pinned sessions are returned in a separate pinned group first (label `Đã ghim`), then time groups; each group preserves `lastUpdated` descending.

- [ ] **Step 3: Implement Sidebar**

Layout: logo + collapse, `Cuộc trò chuyện mới`, `Tìm kiếm` (Ctrl/Cmd+K), `Dự án` collapsible list, `Gần đây` grouped list with title + project name, hover pin/delete. Collapsed state persists to localStorage key `morphi.sidebarCollapsed`; footer shows version and connection status. Register global shortcuts in `AppShell`: Ctrl/Cmd+K opens search, Ctrl/Cmd+N starts a new chat; ignore shortcuts while focus is in an input unless the key is the palette shortcut.

- [ ] **Step 4: Implement SearchPalette**

Modal with input, filter across session titles and project names, keyboard up/down/enter/escape, focus trap, and `aria-label` from `vi`. Selecting a result calls `onSelectSession`.

- [ ] **Step 5: Test and browser check**

Run: `cd client && npm test -- --run src/lib/sessionGroups.test.ts src/components/layout/Sidebar.test.tsx`.
Expected: PASS.
Manual: create sessions across dates, verify grouping; press Ctrl+K, search, select; collapse/expand at desktop and mobile widths.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(ui): add ChatGPT-style sidebar, recents groups, and search palette`.

---

### Task 22: Header, welcome view, composer, and model picker

**Files:**
- Create: `client/src/components/layout/Header.tsx`, `client/src/components/chat/WelcomeView.tsx`, `Composer.tsx`, `ModelPicker.tsx`, tests `Composer.test.tsx`, `ModelPicker.test.tsx`
- Modify: `client/src/components/ChatInterface.tsx`

**Interfaces:**
- Consumes: `ModelInfo[]`, `mcpStatus`, agent status.
- Produces: `Composer` props `{ onSend, onStop, disabled, models, selectedModel, onModelChange, thinking, onThinkingChange, onOpenTools, onOpenSettings }`.

- [ ] **Step 1: Write failing composer tests**

Test Enter sends trimmed text, Shift+Enter inserts newline, Stop button calls `onStop`, send is disabled while loading, and `+` opens the tools panel with tool count.

- [ ] **Step 2: Implement Header**

Left: sidebar toggle + breadcrumb `Dự án › Phiên`. Center: agent status text (`Sẵn sàng`, `Đang nghĩ`, `Đang chạy tool`). Right: MCP chip (`Bridge Active`, `Đang kết nối`, `Mất kết nối`) and theme toggle. No tabs, no fake usage card.

- [ ] **Step 3: Implement WelcomeView**

Heading `Hôm nay bạn muốn xây gì?`; four suggestion rows: `Tạo hệ thống combat`, `Thiết kế DataStore`, `Debug placement`, `Tạo cutscene`; clicking sends the Vietnamese prompt.

- [ ] **Step 4: Implement Composer and ModelPicker**

Composer is a rounded card with auto-growing textarea (max 200px), placeholder `Hỏi Morphi bất cứ điều gì…`, `+` tools button, model picker (`Tự động` + usable models only), deep-thinking toggle, send/stop. ModelPicker groups by provider, filters disabled providers, and shows a CTA `Mở Cài đặt` when no provider is configured.

- [ ] **Step 5: Test and browser check**

Run: `cd client && npm test -- --run src/components/chat/Composer.test.tsx src/components/chat/ModelPicker.test.tsx`.
Expected: PASS.
Manual: verify Enter/Shift+Enter, auto-grow, stop, model menu keyboard navigation, thinking toggle, suggestions, responsive width.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(ui): add ChatGPT-style header, welcome, composer, and model picker`.

---

### Task 23: Chat rendering, thinking, tool cards, approvals, errors

**Files:**
- Create: `client/src/components/chat/ChatView.tsx`, `MessageItem.tsx`, `ThinkingBlock.tsx`, `ToolCallCard.tsx`, `PlanPanel.tsx`, `ApprovalModal.tsx`, `ErrorCard.tsx`, tests for each behavior
- Modify: `client/src/components/ChatInterface.tsx` to use `ChatView`

**Interfaces:**
- Consumes: `DerivedMessage`, `DerivedStep`, `ApprovalRequest`, `agentStatus`, latest `todo_write` result.
- Produces: rendering components plus `onRegenerate`, `onCopy`, `onApprovalDecision`.

- [ ] **Step 1: Write failing rendering tests**

Test assistant text markdown, user bubble alignment, thinking block collapsed by default with `Đã suy nghĩ trong Xs`, tool card status labels `Đang chạy / Hoàn tất / Lỗi / Đã huỷ`, expandable args/result, plan panel showing todo statuses, error card with retry, and approval modal buttons `Cho phép một lần`, `Cho phép trong phiên`, `Từ chối`.

- [ ] **Step 2: Implement MessageItem**

User messages align right with a light gray bubble and render `content` directly. Assistant messages are full-width with an `M` avatar and render `message.steps` in order: `text` steps as markdown, `call`/`approval` steps as their components. Do not render `content` a second time; it feeds the copy button and token footer. Footer: copy, regenerate, token usage.

- [ ] **Step 3: Implement ThinkingBlock and ToolCallCard**

ThinkingBlock uses `<details>` or a controlled collapsible; closed by default; shows streaming text while active; duration computed from message timestamps. ToolCallCard maps tool names to Vietnamese labels (keep raw name in a monospace subtitle), shows status, args/result JSON with truncation, and an error style.

- [ ] **Step 4: Implement PlanPanel, ApprovalModal and ErrorCard**

PlanPanel reads the latest completed `todo_write` tool result in the session, renders `Chưa làm / Đang làm / Xong` with a progress count, and hides itself when no todos exist. ApprovalModal is a focus-trapped dialog with tool name, args JSON, risk badge, warning text, and the three decisions; it calls `onDecision(id, decision, scope)`. ErrorCard maps codes `NO_PROVIDER`, `UNAUTHORIZED`, `RATE_LIMIT`, `TURN_TIMEOUT`, `PROVIDER_ERROR` to Vietnamese friendly messages and a primary CTA.

- [ ] **Step 5: Test and browser check**

Run: `cd client && npm test -- --run src/components/chat`.
Expected: PASS.
Manual: use a fake scripted tool call, approve/deny, stop mid-tool, reload session; verify thinking and tool steps persist and no duplicate text appears.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(ui): render thinking, tool calls, approvals, and errors`.

---

### Task 24: Settings, memory, onboarding, theme, responsive, accessibility

**Files:**
- Create: `client/src/components/settings/SettingsModal.tsx`, `client/src/components/settings/ProviderCard.tsx`, `MemoryPanel.tsx`, `McpPanel.tsx`, `AdvancedPanel.tsx`
- Modify: `client/src/components/OnboardingModal.tsx`, `client/src/components/ChatInterface.tsx`, `client/src/index.css`
- Delete once the replacements render: `client/src/components/InputArea.tsx`, `Message.tsx`, `Sidebar.tsx`, `MemoryManagerModal.tsx`, `client/src/components/SettingsModal.tsx`
- Tests: `SettingsModal.test.tsx`, `accessibility.test.tsx`

**Interfaces:**
- Consumes: `window.morphi.credentials`, `api.providers`, `api.mcp`, `api.memory`.
- Produces: tabbed Settings with masked keys and IPC-only credential writes.

- [ ] **Step 1: Write failing Settings tests**

Test provider key input is masked and never renders a stored key; save calls `window.morphi.credentials.set`; delete calls `delete`; status comes from `window.morphi.credentials.status`; base URL save calls `api.providers.updateConfig`; a custom connector saves both the config and the IPC key; Advanced fields are read-only.

- [ ] **Step 2: Implement Settings layout**

Left nav: `Chung`, `Nhà cung cấp`, `MCP`, `Bộ nhớ`, `Nâng cao`. Right panel scrolls. Provider cards show `Đã cấu hình / Chưa cấu hình / Lỗi`, masked key placeholder `••••••••`, base URL for custom connectors, save/delete. A `Thêm connector` form collects a slug, base URL, and key; saving calls `api.providers.updateConfig('custom:<slug>', { baseUrl, enabled: true })` and `window.morphi.credentials.set('custom:<slug>', key)`. Show a warning when `safeStorage` is unavailable (`persistent === false`).

- [ ] **Step 3: Implement MCP, Memory, Advanced panels**

MCP: connected/studioLinked, bundled version `2.6.0`, reconnect, last log lines. Memory: project/session/event counts, file size, warning with the backup file name when `legacyBackup` is present, clear data with ConfirmModal. Advanced: title model, auto priority, compaction thresholds read-only, with a note that they are configured in `settings.json`/env in 1.1.0.

- [ ] **Step 4: Theme, onboarding, responsive, accessibility**

Theme toggle persists `morphi.theme` and respects system preference; onboarding restyled and Vietnamese; sidebar overlay below 1024px; composer full width below 768px; modals trap focus; icon buttons have `aria-label`; agent status uses `aria-live="polite"`; reduced motion honored.

- [ ] **Step 5: Test and browser check**

Run: `cd client && npm test -- --run src/components/settings src/components/accessibility.test.tsx`.
Expected: PASS.
Manual: test all tabs, save/delete key, reconnect, clear data with cancel/confirm, theme persistence, keyboard-only navigation, 1440/1024/768/375 widths.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(ui): redesign settings and complete theme, responsive, and a11y work`.

---

### Task 25: Playwright E2E and UI verification gate

**Files:**
- Create: `client/playwright.config.ts`, `client/e2e/app.spec.ts`, `client/e2e/fixtures.md`, `server/src/harness/llm/fake.ts`
- Modify: `server/src/harness/harness.ts` (fake mode), `client/package.json`, root `package.json`

**Interfaces:**
- Consumes: dev server, harness, fake LLM.
- Produces: E2E suite for the golden paths and a written UI verification checklist.

- [ ] **Step 1: Add fake LLM adapter**

`createFakeAdapter(script: FakeScript)` emits deterministic text/tool events. `MORPHI_FAKE_LLM=1` selects it in the composition root: register only the fake adapter (models `fake-tools`, `fake-text`), put `fake` first in the auto priority, and seed a fake credential so `getModels()` and `resolveAuto()` succeed. Scripts include `text`, `tool-then-text`, `missing-key`, `slow`, and `cancel`. The fake adapter selects the script from a leading `/script <name>` marker in the user message and falls back to `MORPHI_FAKE_SCRIPT` (default `text`), so one E2E server can serve every scenario. The `missing-key` script emits a live `error` with code `NO_PROVIDER` so the UI error path can be tested without removing the fake provider. The fake adapter honors the signal and never calls the network.

- [ ] **Step 2: Add Playwright config**

Run `cd client && npm install -D @playwright/test && npx playwright install chromium`. Add `"e2e": "playwright test"` to `client/package.json` and `"e2e": "npm --prefix client run e2e"` to the root.

`webServer` is an array with two entries, both run from `client/`: the server (`npm --prefix ../server run dev`, env `MORPHI_FAKE_LLM=1`, `MORPHI_DB_PATH=./.tmp/e2e.db`, `MORPHI_PORT=3000`) and the client dev server (`npm run dev`). Both use `reuseExistingServer: !process.env.CI`. `use.baseURL` is `http://localhost:5173`; the token is `dev-token`. Test artifacts go to `test-results/`.

- [ ] **Step 3: Write E2E scenarios**

1. Fresh DB → first message succeeds (`/script text`).
2. Missing provider → send `/script missing-key`, see inline error + Settings CTA.
3. Scripted tool call → send `/script tool-then-text`, approval allow; tool card completes; assistant continues.
4. Approval deny → same script with deny; tool card shows `Đã huỷ`/error and no tool side effect.
5. Stop mid-stream → `/script slow`, status `Đã dừng`, no further deltas.
6. Regenerate → old assistant replaced, user message appears once.
7. Reload session → text, thinking, tool steps, and approval decisions restored.
8. Search palette, new chat, theme toggle, and sidebar collapse.
9. Responsive at 1024 and 768 widths; no horizontal overflow.

- [ ] **Step 4: Run E2E and fix regressions**

Run: `cd client && npx playwright test`.
Expected: all E2E scenarios PASS on Windows. If a test fails, fix the product code rather than loosening the assertion.

- [ ] **Step 5: Perform the UI verification gate**

Run `npm run dev`, open the app in a browser, and record a checklist with screenshots for: welcome, composer, model picker, thinking, tool call, approval, error, settings, memory, search, light/dark, mobile widths. Check DevTools console for errors. Do not mark Phase 3 complete until every item passes.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `test(e2e): cover chat golden paths and UI verification checklist`.

---

# Phase 4 — Advanced Harness

### Task 26: Plugin registry and disposal

**Files:**
- Create: `server/src/harness/plugins/registry.ts`, `index.ts`, `server/src/harness/plugins/registry.test.ts`
- Modify: `server/src/harness/harness.ts`

**Interfaces:**
- Consumes: `HarnessContext`.
- Produces: `HarnessPlugin`, `PluginRegistry.setupAll()`, `disposeAll()`.

- [ ] **Step 1: Write failing plugin test**

Two fake plugins must run `setup` in registration order; `dispose` runs in reverse; a failing setup prevents later plugins and surfaces the error.

- [ ] **Step 2: Implement registry and built-in order**

```ts
export interface HarnessContext { harness: Harness; }

export interface HarnessPlugin { id: string; version: string; setup(ctx: HarnessContext): Promise<void> | void; dispose?(): Promise<void> | void; }
```

`plugins/index.ts` lists built-ins in fixed order: tools, skills, goals, workflows, subagents. In Task 26 it registers only the tools entry (the others do not exist yet); Tasks 27–30 append their plugin in that order. No external loading in 1.1.0.

- [ ] **Step 3: Wire harness setup and shutdown; run tests**

Run: `cd server && npx vitest run src/harness/plugins/registry.test.ts`.
Expected: PASS.

- [ ] **Step 4: Commit checkpoint**

Suggested message: `feat(harness): add plugin registry and disposal lifecycle`.

---

### Task 27: Skills loader, built-ins, API, and picker UI

**Files:**
- Create: `server/src/harness/skills/loader.ts`, `server/src/harness/skills/builtin/roblox-luau-style.md`, `roblox-debug.md`, `server/src/harness/skills/loader.test.ts`, `server/src/routes/skills.ts`, `client/src/components/harness/SkillPicker.tsx`, `client/src/components/harness/SkillPicker.test.tsx`
- Modify: `server/package.json` (add `gray-matter`), `server/scripts/copy-assets.js`, `server/src/harness/harness.ts`, `server/src/harness/agent/loop.ts`, `server/src/routes/index.ts`, `client/src/components/Composer.tsx`

**Interfaces:**
- Consumes: prompt assembly, event store.
- Produces: `SkillLoader.list()`, `SkillLoader.get(name)`, `SkillLoader.active(sessionId)`, `SkillLoader.activeBodies(sessionId): Promise<string[]>`, `setActive(sessionId, names)`, `matchTriggers(text)`; API `GET /api/skills`, `POST /api/sessions/:id/skills/:name`.

- [ ] **Step 1: Write failing loader test**

Fixture Markdown with frontmatter `name`, `description`, `triggers`; assert parse; assert duplicate names prefer user directory; assert missing frontmatter is skipped with a warning.

- [ ] **Step 2: Implement loader and asset copying**

Use `gray-matter`. Load bundled files from `path.join(__dirname, 'builtin')` and user files from `%APPDATA%/MorphiIntelligence/skills`. `server/scripts/copy-assets.js` copies `src/harness/skills/builtin/*.md` to `dist/harness/skills/builtin/`; server build script becomes `tsc && node scripts/copy-assets.js`.

- [ ] **Step 3: Persist active skills**

Extend the `Harness` interface with `skills: SkillLoader`, construct the loader in `createHarness`, and add `skills: SkillLoader` to the `AgentLoop` dependency object. `setActive` appends `session/skills` with the sorted skill names. `AgentLoop` loads the latest `session/skills` list through the injected `SkillLoader` and passes the active skill bodies into `assembleSystemPrompt`; before Task 27 adds the loader, the skills array is empty. Tests assert an active skill body appears in the system prompt and inactive skills do not. `SkillLoader.matchTriggers(text)` returns skills whose `triggers` occur in the user message; the chat route activates them (append `session/skills`) before running the turn.

- [ ] **Step 4: Add API and UI**

Routes list skills and toggle one per session with `{ enabled }`. `SkillPicker` shows built-in skills with descriptions and checkboxes; it calls the API and refreshes chat on change. `Composer` also recognizes `/skill <name>` and calls the same toggle API before sending the remaining text.

- [ ] **Step 5: Run tests and browser check**

Run: `cd server && npx vitest run src/harness/skills` and `cd client && npm test -- --run src/components/harness/SkillPicker.test.tsx`.
Expected: PASS.
Manual: activate `roblox-debug`, send a message, confirm the prompt section is present in debug logs (redacted) and the UI reflects the active state after reload.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(harness): add skills loader, built-in skills, API, and picker`.

---

### Task 28: Goals service, runner, API, and GoalBar

**Files:**
- Create: `server/src/harness/goals/service.ts`, `runner.ts`, tests; `server/src/routes/goals.ts`; `client/src/components/harness/GoalBar.tsx`, `client/src/components/harness/GoalBar.test.tsx`
- Modify: `server/src/harness/tools/builtin/` (add `goal_update.ts`), `server/src/routes/chat.ts`, `server/src/routes/index.ts`, `client/src/components/Header.tsx`

**Interfaces:**
- Consumes: `EventStore`, `AgentLoop`.
- Produces: `GoalService.start(sessionId, objective)`, `status(sessionId)`, `mark(sessionId, status)`; `GoalRunner.run(sessionId)`; API `POST/DELETE /api/sessions/:id/goal`; `goal_update` tool.

- [ ] **Step 1: Write failing goal tests**

Start goal appends `goal/changed active`; `goal_update done` appends `goal/changed done`; runner stops at 12 turns; blocked status stops immediately.

- [ ] **Step 2: Implement GoalService and tool**

Extend the `Harness` interface with `goals: GoalService` and `goalRunner: GoalRunner`. One active goal per session. `goal_update` schema `{ status: 'done'|'blocked', summary: string }`; it calls `GoalService.mark`. Prompt runtime includes objective and status. Every `goal/changed` also updates the `sessions.goal_id` cache: the active goal id while active, `NULL` when done/blocked.

- [ ] **Step 3: Implement GoalRunner**

After each completed turn, check goal status. If active, start another turn with `trigger: 'goal'`, no user message, and a system instruction to continue the objective. Stop starting new turns at done/blocked or after 12 goal turns; the agent's own `turn/end` events remain the only turn boundaries, so do not append synthetic `turn/end` events from the runner.

- [ ] **Step 4: Add API and GoalBar**

`POST` starts a goal and returns it; `DELETE` marks it blocked/cancelled. GoalBar shows objective, turn count, and stop button; it polls or consumes SSE status.

- [ ] **Step 5: Run tests and browser check**

Run: `cd server && npx vitest run src/harness/goals` and `cd client && npm test -- --run src/components/harness/GoalBar.test.tsx`.
Expected: PASS.
Manual: start a goal with the fake adapter set to call `goal_update done`; verify GoalBar updates and the loop stops.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(harness): add goals runner, goal tool, API, and goal bar`.

---

### Task 29: Workflow engine, built-ins, API, and timeline UI

**Files:**
- Create: `server/src/harness/workflows/engine.ts`, `builtin/robloxFeature.ts`, `builtin/robloxDebug.ts`, tests; `server/src/routes/workflows.ts`; `client/src/components/harness/WorkflowTimeline.tsx`, `client/src/components/harness/WorkflowTimeline.test.tsx`
- Modify: `server/src/routes/index.ts`, prompt assembly, harness composition, composer tools panel

**Interfaces:**
- Consumes: `AgentLoop`.
- Produces: `WorkflowEngine.list()`, `run(sessionId, name)`, events `workflow/*`; API `GET /api/workflows`, `POST /api/sessions/:id/workflows`.

- [ ] **Step 1: Define workflow shape**

```ts
export interface WorkflowPhase { name: string; prompt: string; tools?: string[]; }
export interface WorkflowDefinition { name: string; description: string; phases: WorkflowPhase[]; }
```

- [ ] **Step 2: Write failing engine test**

A two-phase fake workflow appends `workflow/start`, `workflow/phase started/completed` per phase, and `workflow/end completed`; a phase error ends with `failed`; cancellation ends with `cancelled`.

- [ ] **Step 3: Implement engine and built-ins**

Extend the `Harness` interface with `workflows: WorkflowEngine`. `roblox-feature` phases: `Khảo sát`, `Thiết kế`, `Triển khai`, `Kiểm tra`. `roblox-debug` phases: `Tái hiện`, `Khoanh vùng`, `Sửa`, `Xác minh`. Each phase runs an agent turn with phase prompt and optional tool subset. `POST /api/sessions/:id/workflows` starts the workflow in the background and returns `202 { workflowId }`; the engine writes `workflow/*` durable events and maps an aborted turn to `workflow/end cancelled`.

- [ ] **Step 4: Add API and timeline UI**

Routes list/run workflows. `WorkflowTimeline` renders phases with `Đang chạy / Hoàn tất / Lỗi` and a stop button. While a workflow is active it polls `GET /api/sessions/:id/events?after=<lastSeq>` once per second and stops polling when `workflow/end` arrives; the stop button calls `POST /api/chat/cancel` for the session, which aborts the current phase turn.

- [ ] **Step 5: Run tests and browser check**

Run: `cd server && npx vitest run src/harness/workflows` and `cd client && npm test -- --run src/components/harness/WorkflowTimeline.test.tsx`.
Expected: PASS.
Manual: run both built-in workflows with fake scripts; verify timeline states and final status.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(harness): add built-in workflows, API, and timeline`.

---

### Task 30: Subagent runtime and progress card

**Files:**
- Create: `server/src/harness/subagents/runtime.ts`, `runtime.test.ts`, `client/src/components/harness/SubagentCard.tsx`, `SubagentCard.test.tsx`
- Modify: `server/src/harness/tools/` (add `subagent_run` tool), prompt/UI wiring

**Interfaces:**
- Consumes: `AgentLoop`, `SessionStore`.
- Produces: `SubagentRuntime.run({ parentSessionId, task, tools? })`, max depth 2, max 3 concurrent; events `subagent/start/end`.

- [ ] **Step 1: Write failing runtime tests**

Depth 2 child can run; depth 3 rejects. A fourth concurrent call waits in a FIFO queue until a slot frees (max 3 running). Child session is created; parent receives summary; `subagent/start` and `subagent/end` are appended.

- [ ] **Step 2: Implement runtime**

Extend the `Harness` interface with `subagents: SubagentRuntime`. Create a child session with title `Subagent: <task>`, run the agent loop with a restricted tool registry, collect final text as summary, and enforce depth/concurrency with a semaphore. Emit live progress to the parent.

- [ ] **Step 3: Add tool and UI**

`subagent_run` validates `{ task: string, tools?: string[] }`, approval `ask` (medium risk). `SubagentCard` shows task, status, child session link, and summary; it renders from events.

- [ ] **Step 4: Run tests and browser check**

Run: `cd server && npx vitest run src/harness/subagents` and `cd client && npm test -- --run src/components/harness/SubagentCard.test.tsx`.
Expected: PASS.
Manual: ask the fake agent to run a subagent; verify card progress, completion, and that the child session is readable.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `feat(harness): add subagent runtime and progress card`.

---

# Phase 5 — Hardening & Release

### Task 31: Pin and bundle MCP, spawn with Electron Node

**Files:**
- Create: `server/src/harness/mcp/entry.ts`, `entry.test.ts`, `server/test/fixtures/node_modules/robloxstudio-mcp/package.json`, `server/test/fixtures/node_modules/robloxstudio-mcp/dist/cli.js`
- Modify: `server/src/services/McpService.ts` (keep the path used by `serviceGateway.ts`), root `package.json` dependencies and build config

**Interfaces:**
- Consumes: `McpGateway`.
- Produces: `resolveBundledMcpEntry(searchPaths: string[], execPath?: string): { command: string; args: string[]; env: NodeJS.ProcessEnv }`; pinned `robloxstudio-mcp@2.6.0` installed at the repo root so electron-builder bundles it with the root `node_modules`.

- [ ] **Step 1: Add pinned dependency**

Run at the repo root: `npm install robloxstudio-mcp@2.6.0`. Record the exact version in the root `package-lock.json`. Do not use `@latest`. Installing at the root (not `server/`) is required because packaging includes root `node_modules`, and Node resolves upward from `server/dist`.

- [ ] **Step 2: Write failing entry resolver test**

Fixture package under `fixtures/node_modules/robloxstudio-mcp` with `"bin": { "robloxstudio-mcp": "dist/cli.js" }`; call `resolveBundledMcpEntry([fixturesDir], 'electron.exe')` and expect `command: 'electron.exe'`, `args` containing the absolute `dist/cli.js` path, and `env.ELECTRON_RUN_AS_NODE === '1'`.

- [ ] **Step 3: Implement resolver and service spawn**

`resolveBundledMcpEntry` uses `require.resolve('robloxstudio-mcp/package.json', { paths: searchPaths })`, reads `bin`, and resolves the CLI JS relative to the package root. Production passes `[serverDir, appRoot]` and `process.execPath`; dev passes the same search paths but falls back to `npx` when the package is missing. If the resolved path is inside `app.asar`, rewrite it to `app.asar.unpacked` because the spawned Electron Node process cannot read asar archives. Production: spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and that JS path. Dev: spawn `npx -y robloxstudio-mcp@2.6.0` only as a fallback with a clear warning. Use `stderr: 'pipe'` and parse the same Studio link messages. Expose connected/studioLinked/reconnect/logs.

- [ ] **Step 4: Test and manual Studio check**

Run: `cd server && npx vitest run src/harness/mcp/entry.test.ts`.
Expected: PASS.
Manual: open Roblox Studio with the plugin, start the packaged app, confirm tools list loads, reconnect works, and status returns `studioLinked: true`. If Studio is unavailable, record the exact failure and verify the app shows a clear disconnected state.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `feat(mcp): pin and bundle robloxstudio-mcp 2.6.0`.

---

### Task 32: Packaging, CI, documentation, version release

**Files:**
- Modify: root `package.json` build config, `.github/workflows/ci.yml`, `README.md`, `server/package.json`, `client/package.json`
- Create: `scripts/verify-packaged.js`, `docs/release-checklist.md` (optional)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: portable Windows build, CI green on Windows/Ubuntu, complete docs.

- [ ] **Step 1: Fix electron-builder file list**

Include `main.js`, `preload.js`, `main/**/*`, `server/dist/**/*`, `server/scripts/**/*`, `client/dist/**/*`, and production `node_modules`. Because the build ships only the root `node_modules`, install every server runtime dependency at the root too (`express`, `better-sqlite3`, `dotenv`, `@modelcontextprotocol/sdk`, `ajv`, `zod`, `gray-matter`) or add `server/node_modules/**/*` to `files`; prefer root installs to keep the package small and consistent with the existing layout. Add `asarUnpack` for `better-sqlite3` native files and `node_modules/robloxstudio-mcp/**/*`; ensure `server/dist/harness/skills/builtin/*.md` is included. Exclude test files, source maps, `.env`, DB/WAL, build logs. Confirm electron-builder rebuilds `better-sqlite3` against the Electron ABI, not the system Node ABI.

- [ ] **Step 2: Add packaged verification script**

`scripts/verify-packaged.js` checks that the packaged resources contain `server/dist/index.js`, `preload.js`, `better-sqlite3` `.node`, the pinned MCP package, and no `credentials.json`. Run it in CI after packaging.

- [ ] **Step 3: Extend CI**

Windows + Ubuntu: `npm ci` at root, server, and client; `npm --prefix client run lint`; typecheck; unit/integration tests; build. Windows only: `npx playwright install chromium`, Playwright E2E, electron-builder portable, packaged verification. Upload the portable artifact and Playwright report.

- [ ] **Step 4: Rewrite README and release docs**

README sections: architecture diagram, requirements, dev setup, environment variables, provider setup via Settings, MCP/Roblox Studio troubleshooting, test commands, security model, package command, known limitations. Document that 1.1.0 resets the old DB to `morphi.db.v1.bak`. Add the ISC license reference.

- [ ] **Step 5: Build and verify portable app**

Run: `npm run build && npm run dist`.
Then on a clean Windows profile without Node installed, launch the portable executable, complete onboarding, configure a provider key, send a message, run a tool call with approval, stop, reload, and open Settings/MCP. Confirm the DB is created under `%APPDATA%/MorphiIntelligence`, no key is plaintext, and the app does not depend on a local Node installation.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `build: package Morphi 1.1.0 with bundled MCP and release docs`.

---

### Task 33: Final acceptance and real UI verification

**Files:**
- Modify: only defects found; update `docs/superpowers/specs/2026-11-02-morphi-harness-ui-design.md` status to `Implemented` when complete.

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`, `npm run typecheck`, `npm run build`, `cd client && npx playwright test`.
Expected: all pass. Capture output and artifact paths.

- [ ] **Step 2: Run the spec acceptance checklist**

Verify every item in spec Section 12: fresh DB first message, missing key inline error, stop ≤2s, regenerate no duplicate, reload restores thinking/tool/approval, no plaintext keys, no hardcoded localhost, usable model picker only, bundled MCP on clean machine, Vietnamese ChatGPT layout light/dark with no console errors, no dead files, versions 1.1.0, portable build works.

- [ ] **Step 3: Perform the requested UI re-check**

Start the real app (and the packaged app), use it end-to-end in a browser/Electron window, and compare against the reference layout: rail + sidebar + main, Vietnamese copy, light/dark, welcome suggestions, composer, model picker, thinking, tool cards, approval modal, settings tabs, search palette, responsive widths, keyboard shortcuts, focus rings, and no console errors. Record screenshots and the checklist in `client/e2e/fixtures.md` or the release notes.

- [ ] **Step 4: Fix any defects found and re-run the affected checks**

No acceptance claim is allowed until the automated tests and the real UI check both pass. If a limitation remains (for example Roblox Studio is unavailable), state it explicitly with evidence.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `release: Morphi Intelligence 1.1.0 acceptance verified`.

---

## Spec Coverage Map

| Spec area | Tasks |
|---|---|
| Runtime topology, token, loopback | 2, 3 |
| Credentials/safeStorage/IPC | 4, 7, 24 |
| DB schema, legacy backup | 8 |
| Event vocabulary/store | 9 |
| Projections/regenerate | 10, 18, 19 |
| Sessions/title | 11, 18 |
| Provider seam/adapters/auto model | 12, 13 |
| Tool pipeline/approval/built-ins | 14 |
| Prompt/compaction | 15 |
| Agent loop/retry/cancel/inbox | 16, 18 |
| HTTP API/SSE | 17, 18 |
| UI layout/composer/chat/settings | 20–24 |
| E2E/UI verification | 25, 33 |
| Plugins/skills/goals/workflows/subagents | 26–30 |
| MCP pin/bundle | 31 |
| Cleanup/docs/CI/release | 7, 17, 32, 33 |
| Log redaction | 2 |

## Execution Notes

- Each task is independently reviewable. Do not start a task until its dependencies are merged or present in the working tree.
- Keep changes focused. If a task reveals hidden complexity, stop and update the plan rather than silently expanding scope.
- Never expose credentials in logs, test snapshots, or SSE payloads.
- Every UI task ends with a real browser/Electron check, not just unit tests. The final UI re-check in Task 33 is mandatory.
