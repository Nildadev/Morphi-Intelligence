const { isValidProviderId } = require('./credentials');

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The renderer is the only trusted caller. It is always served over plain http
// from the loopback backend, so anything else (missing frame, file://, https,
// extensions, remote hosts) is rejected without revealing why.
function assertTrustedSender(event) {
  const url = event && event.senderFrame && event.senderFrame.url;
  if (typeof url !== 'string' || url === '') throw new Error('UNTRUSTED_SENDER');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('UNTRUSTED_SENDER');
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error('UNTRUSTED_SENDER');
  }
  return true;
}

function readCredentialArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('INVALID_ARGUMENT');
  const providerId = args.providerId;
  if (!isValidProviderId(providerId)) throw new Error('INVALID_ARGUMENT');
  return { providerId, apiKey: args.apiKey };
}

function registerIpc({ ipcMain, store, getBackend }) {
  // Push the full decrypted map so deletions propagate: the server replaces its
  // holder instead of merging, so a provider missing here is disabled there.
  const push = () => {
    const backend = getBackend();
    const child = backend && backend.child;
    if (!child || typeof child.postMessage !== 'function') return false;
    try {
      child.postMessage({ type: 'credentials', keys: store.all() });
      return true;
    } catch {
      // Never log the payload or the error text: both can carry key material.
      console.error('[ipc] Failed to push credentials to the server process');
      return false;
    }
  };

  ipcMain.handle('morphi:credentials:set', (event, args) => {
    assertTrustedSender(event);
    const { providerId, apiKey } = readCredentialArgs(args);
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error('INVALID_ARGUMENT');
    store.set(providerId, apiKey);
    push();
    return { ok: true, persistent: store.persistent };
  });

  ipcMain.handle('morphi:credentials:delete', (event, args) => {
    assertTrustedSender(event);
    const { providerId } = readCredentialArgs(args);
    store.delete(providerId);
    push();
    return { ok: true };
  });

  ipcMain.handle('morphi:credentials:status', (event) => {
    assertTrustedSender(event);
    return { persistent: store.persistent, providers: store.status() };
  });

  return { push };
}

module.exports = { assertTrustedSender, registerIpc };
