import { defineConfig } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Task 25 — Playwright E2E + UI verification gate.
 *
 * R25-1: @playwright/test 1.64.1 resolves chromium-1248 / headless-shell-1248 / ffmpeg-1013, all of
 * which are already in %LOCALAPPDATA%\ms-playwright. No `playwright install` is run here.
 *
 * R25-8 (measured in the round-4 verdict): `better_sqlite3.node` was compiled for NODE_MODULE_VERSION
 * 147 (C:\Program Files\nodejs\node.exe, v26.12.0) while WorkBuddy's node is 22.22.2 / ABI 127.
 * Starting the server with the wrong node produces 113 false test failures and a dead dev server.
 * The server webServer therefore invokes the ABI-147 binary by absolute path. The Vite dev server
 * has no native dependency and runs with the ambient npm.
 *
 * R25-2: fake mode lives in `server/src/index.ts`; this config only sets the env flag.
 * R25-7: no process is killed here. Playwright owns both servers and shuts them down itself.
 */
// This machine exports HTTP_PROXY/HTTPS_PROXY with an empty NO_PROXY. Playwright's webServer
// liveness probe then receives a 502 from the local proxy and concludes BOTH servers are already
// running, skipping the launch (measured: page.goto → ERR_CONNECTION_REFUSED on 127.0.0.1:5173).
// Set the bypass at config-load time, before any webServer check happens.
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = process.env.NO_PROXY;

const NODE_ABI_147 = 'C:\\Program Files\\nodejs\\node.exe';
// `client/package.json` is `"type": "module"`, so `__dirname` is not available in this config.
// npm runs the e2e script with cwd = client/, which is also where Playwright resolves testDir from.
const CLIENT_DIR = path.resolve(process.cwd());
const SERVER_DIR = path.resolve(CLIENT_DIR, '../server');
const DB_DIR = path.join(SERVER_DIR, '.tmp');
fs.mkdirSync(DB_DIR, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The Vite proxy forwards /api to 127.0.0.1:3000; the client falls back to `dev-token` in DEV.
  },
  webServer: [
    {
      command: `"${NODE_ABI_147}" node_modules/ts-node/dist/bin.js src/index.ts`,
      cwd: SERVER_DIR,
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        MORPHI_FAKE_LLM: '1',
        MORPHI_FAKE_SCRIPT: 'text',
        MORPHI_PORT: '3000',
        MORPHI_TOKEN: 'dev-token',
        MORPHI_DB_PATH: './.tmp/e2e.db',
      },
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      cwd: CLIENT_DIR,
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
