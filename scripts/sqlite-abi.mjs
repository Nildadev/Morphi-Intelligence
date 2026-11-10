// better-sqlite3 ships one native binding per ABI: Node and Electron never share one. Keep a
// cache of each binding we have seen and swap the live copies before dev/test (Node) or
// start/dist (Electron), so neither runtime dies with ERR_DLOPEN_FAILED.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'server', '.native');
const livePaths = [
  path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  path.join(root, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
];
const mode = process.argv[2] ?? 'node';

function loadsHere(file) {
  try {
    process.dlopen({ exports: {} }, file);
    return true;
  } catch {
    return false;
  }
}

function electronAbi() {
  const exe = require('electron');
  const probe = spawnSync(exe, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (probe.status !== 0) throw new Error(`cannot probe Electron ABI: ${probe.stderr}`);
  return probe.stdout.trim();
}

function cachePath(abi) {
  return path.join(cacheDir, `abi-${abi}.node`);
}

function sameFile(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

function install(abi) {
  const source = cachePath(abi);
  for (const live of livePaths) {
    if (!existsSync(path.dirname(live))) continue;
    if (sameFile(live, source)) continue;
    mkdirSync(path.dirname(live), { recursive: true });
    copyFileSync(source, live);
    console.log(`[sqlite-abi] ${path.relative(root, live)} -> ABI ${abi}`);
  }
}

const target = mode === 'electron' ? electronAbi() : process.versions.modules;
mkdirSync(cacheDir, { recursive: true });

if (!existsSync(cachePath(target))) {
  if (mode === 'electron') {
    console.log('[sqlite-abi] no Electron binding cached; running electron-rebuild');
    const rebuild = spawnSync('npm', ['exec', '--', 'electron-rebuild', '-f', '-w', 'better-sqlite3'], {
      cwd: path.join(root, 'server'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);
  }
  const donor = mode === 'electron'
    ? livePaths.find((live) => existsSync(live))
    : livePaths.find((live) => loadsHere(live));
  if (!donor) {
    console.error(`[sqlite-abi] no binding for ABI ${target}; run "npm rebuild better-sqlite3" first`);
    process.exit(1);
  }
  copyFileSync(donor, cachePath(target));
  console.log(`[sqlite-abi] cached ABI ${target}`);
}

if (mode === 'cache') process.exit(0);
install(target);