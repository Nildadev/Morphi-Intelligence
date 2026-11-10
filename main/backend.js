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
  // Required lazily so createReadyPromise can be unit-tested under plain Node,
  // where the electron package is not installed. In Electron this is identical
  // to requiring utilityProcess at module load.
  const { utilityProcess } = require('electron');
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
