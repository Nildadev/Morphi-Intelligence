// Malformed-input sweep: every endpoint must answer 4xx to junk, never 5xx. A 500 means an unvalidated
// field reached a handler (or a handler assumed a shape the schema did not enforce), which is how a bad
// request from one window breaks a session for the whole process.
//
// The script boots its own server on a scratch database, so it needs no setup:
//   node scripts/api-junk.mjs
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(serverDir, 'dist', 'index.js');
const useBuilt = fs.existsSync(built);
const dbPath = path.join(process.env.TEMP ?? '/tmp', `api-junk-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

const port = String(4000 + (process.pid % 4000));
const base = `http://127.0.0.1:${port}`;
const token = 'junk';

const child = fork(useBuilt ? built : path.join(serverDir, 'src', 'index.ts'), [], {
  cwd: serverDir,
  execArgv: useBuilt ? [] : ['-r', 'ts-node/register/transpile-only'],
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  env: { ...process.env, MORPHI_FAKE_LLM: '1', MORPHI_PORT: port, MORPHI_TOKEN: token, MORPHI_DB_PATH: dbPath },
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the server did not announce readiness within 60s')), 60_000);
  child.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(timer);
      resolve();
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`the server exited before readiness (code ${code})`));
  });
});

// Bodies are chosen to reach past `z.object` traps: wrong primitive, null where an object is expected,
// arrays where a string is expected, prototype keys, huge numbers, injection-shaped strings.
const junkBodies = [
  undefined,
  {},
  null,
  [],
  'not-an-object',
  42,
  { id: null },
  { id: { nested: true } },
  { projectId: [], name: 42 },
  { name: 'x'.repeat(4000) },
  { __proto__: { polluted: true }, name: 'proto' },
  { constructor: 'prototype' },
  { limit: -1 },
  { limit: 1e12 },
  { limit: 'all' },
  { offset: 1.5, limit: -0.5 },
  { query: { $ne: null } },
  { query: "'; DROP TABLE events; --" },
  { model: 12345 },
  { modelSelection: {} },
  { sessionId: '../../../etc/passwd' },
  { attachmentIds: [null, {}] },
  { callIds: new Array(50).fill(0) },
  { approved: 'yes' },
  { decision: 'maybe' },
  { path: 'C:\\Windows\\System32' },
  { path: '../../../../' },
  { content: { toString: 'nope' } },
  { baseUrl: 'not a url' },
  { baseUrl: 'javascript:alert(1)' },
  { providerId: '../escape' },
  { titleModel: { $gt: '' } },
  { autoPriority: 'openai' },
];

const camel = (path) => path.replace(/:(\w+)/g, (_, name) => `missing-${name}`);
const fills = [
  ['get', '/api/projects'],
  ['post', '/api/projects'],
  ['get', '/api/projects/:id'],
  ['put', '/api/projects/:id'],
  ['delete', '/api/projects/:id'],
  ['get', '/api/sessions'],
  ['post', '/api/sessions'],
  ['get', '/api/sessions/:id'],
  ['get', '/api/sessions/:id/events'],
  ['get', '/api/sessions/:id/checkpoints'],
  ['post', '/api/sessions/:id/undo-turn'],
  ['post', '/api/sessions/:id/undo-message'],
  ['post', '/api/sessions/:id/pin'],
  ['post', '/api/sessions/:id/branch'],
  ['post', '/api/sessions/:id/plan'],
  ['post', '/api/sessions/:id/subagent'],
  ['get', '/api/sessions/:id/attachments'],
  ['post', '/api/sessions/:id/goal'],
  ['post', '/api/chat/stream'],
  ['post', '/api/chat/:id/regenerate'],
  ['post', '/api/chat/:id/cancel'],
  ['post', '/api/providers/:id/config'],
  ['post', '/api/providers/:id/connect'],
  ['put', '/api/mcp/path'],
  ['post', '/api/mcp/reconnect'],
  ['post', '/api/memory/clear'],
  ['get', '/api/search'],
  ['get', '/api/files'],
  ['post', '/api/skills'],
  ['post', '/api/subagents'],
  ['post', '/api/approvals/:id'],
];

const sendsBody = (method) => method !== 'get';

async function probe(method, path, body) {
  const init = { method: method.toUpperCase(), headers: { 'X-Morphi-Token': token } };
  if (sendsBody(method) && body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(base + path, init);
  // Drain so the socket is reusable and a streamed error still reports its status.
  await response.text().catch(() => '');
  return response.status;
}

const failures = [];
let checked = 0;

for (const [method, pattern] of fills) {
  const path = camel(pattern);
  for (const body of junkBodies) {
    if (!sendsBody(method) && body !== undefined) continue;
    const status = await probe(method, path, body);
    checked += 1;
    if (status >= 500) {
      failures.push({ method, path, body: body === undefined ? '(no body)' : JSON.stringify(body).slice(0, 80), status });
    }
  }
}

// Raw (non-JSON) bodies exercise the parser itself, not the schema.
for (const raw of ['{', 'null', '"str"', '[]', '\u0000', 'a'.repeat(10000)]) {
  const status = await probe('post', '/api/sessions', raw);
  checked += 1;
  if (status >= 500) failures.push({ method: 'post', path: '/api/sessions', body: `raw ${raw.slice(0, 20)}`, status });
}

child.send({ type: 'shutdown' });
await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill();
    resolve();
  }, 5000);
  child.on('exit', () => {
    clearTimeout(timer);
    resolve();
  });
});
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

console.log(`checked ${checked} malformed requests`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} answered 5xx`);
  for (const failure of failures.slice(0, 40)) console.error(' -', JSON.stringify(failure));
  process.exit(1);
}
console.log('API JUNK OK: no 5xx for malformed input');
