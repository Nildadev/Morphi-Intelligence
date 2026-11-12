// Live check for the orderly-quit path: boot the real server as a child with an IPC channel, ask it to
// quit the way Electron main does, and assert it exits 0 with its database closed (no WAL/SHM left).
//
// Why this cannot be a unit test: the branch under test only runs when the process actually receives the
// quit message. On Windows `child.kill()` is TerminateProcess, so killing the child proves nothing —
// it exits 1/SIGTERM and leaves `-wal`/`-shm` behind (measured). Run from `server/`:
//   node scripts/quit-check.mjs
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(serverDir, 'dist', 'index.js');
const useBuilt = fs.existsSync(built);
const dbPath = path.join(process.env.TEMP ?? '/tmp', `quit-check-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

const port = String(3098 + (process.pid % 500));

const child = fork(useBuilt ? built : path.join(serverDir, 'src', 'index.ts'), [], {
  cwd: serverDir,
  execArgv: useBuilt ? [] : ['-r', 'ts-node/register/transpile-only'],
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  env: {
    ...process.env,
    MORPHI_FAKE_LLM: '1',
    MORPHI_PORT: port,
    MORPHI_TOKEN: 'quittest',
    MORPHI_DB_PATH: dbPath,
  },
});

let ready = false;
child.on('message', (message) => {
  if (!message || message.type !== 'ready') return;
  ready = true;
  console.log(`ready on port ${message.port}`);
  // Same message Electron main sends in `stopBackend()`.
  child.send({ type: 'shutdown' });
});

const result = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
const wal = fs.existsSync(`${dbPath}-wal`);
const shm = fs.existsSync(`${dbPath}-shm`);
console.log('exit', JSON.stringify(result), 'wal', wal, 'shm', shm);

const problems = [];
if (!ready) problems.push('the server never announced readiness over IPC');
if (result.code !== 0) problems.push(`expected exit code 0, got ${JSON.stringify(result)}`);
if (wal || shm) problems.push('the database was not closed: -wal/-shm survived the quit');

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

if (problems.length > 0) {
  console.error('QUIT CHECK FAILED');
  for (const problem of problems) console.error('-', problem);
  process.exit(1);
}
console.log('QUIT CHECK OK');
