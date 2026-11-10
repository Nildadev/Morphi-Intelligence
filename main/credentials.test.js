const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('./credentials');
const { assertTrustedSender, registerIpc } = require('./ipc');

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

// --- IPC and sender validation probes -------------------------------------

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

function fakeBackend() {
  const child = {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
  return { child };
}

function trustedEvent(url = 'http://127.0.0.1:3000/') {
  return { senderFrame: { url } };
}

function makeStore(available = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-ipc-'));
  const file = path.join(dir, 'credentials.json');
  return { file, store: createCredentialStore({ safeStorage: fakeSafeStorage(available), filePath: file }) };
}

test('set and delete push the decrypted key map to the backend child', () => {
  const { file, store } = makeStore();
  const ipcMain = fakeIpcMain();
  let backend = fakeBackend();
  registerIpc({ ipcMain, store, getBackend: () => backend });

  const setResult = ipcMain.handlers.get('morphi:credentials:set')(trustedEvent(), {
    providerId: 'openai',
    apiKey: 'sk-live-secret',
  });
  assert.deepStrictEqual(setResult, { ok: true, persistent: true });
  assert.deepStrictEqual(backend.child.messages, [
    { type: 'credentials', keys: { openai: 'sk-live-secret' } },
  ]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-live-secret'));

  ipcMain.handlers.get('morphi:credentials:delete')(trustedEvent(), { providerId: 'openai' });
  assert.deepStrictEqual(backend.child.messages.at(-1), { type: 'credentials', keys: {} });
  assert.strictEqual(store.get('openai'), undefined);

  // A replacement backend receives the current map, never stale keys.
  backend = fakeBackend();
  ipcMain.handlers.get('morphi:credentials:set')(trustedEvent(), { providerId: 'google', apiKey: 'g-key' });
  assert.deepStrictEqual(backend.child.messages.at(-1), {
    type: 'credentials',
    keys: { google: 'g-key' },
  });
});

test('status returns persistence and provider metadata without keys', () => {
  const { store } = makeStore();
  const ipcMain = fakeIpcMain();
  registerIpc({ ipcMain, store, getBackend: () => null });
  ipcMain.handlers.get('morphi:credentials:set')(trustedEvent(), { providerId: 'google', apiKey: 'g-key' });

  const status = ipcMain.handlers.get('morphi:credentials:status')(trustedEvent());
  assert.deepStrictEqual(status, {
    persistent: true,
    providers: [{ providerId: 'google', configured: true }],
  });
  assert.ok(!JSON.stringify(status).includes('g-key'));
});

test('accepts only loopback http senders', () => {
  const trusted = [
    'http://127.0.0.1:3000/',
    'http://localhost:5173/',
    'http://[::1]:4000/',
    'http://127.0.0.1:3000/settings',
  ];
  for (const url of trusted) assert.strictEqual(assertTrustedSender(trustedEvent(url)), true, url);

  const untrusted = [
    undefined,
    null,
    {},
    { senderFrame: null },
    { senderFrame: {} },
    { senderFrame: { url: '' } },
    { senderFrame: { url: 'not a url' } },
    { senderFrame: { url: 'https://127.0.0.1:3000/' } },
    { senderFrame: { url: 'file:///C:/app/index.html' } },
    { senderFrame: { url: 'http://evil.example/' } },
    { senderFrame: { url: 'http://127.0.0.1.evil.example/' } },
    { senderFrame: { url: 'http://localhost@evil.example/' } },
    { senderFrame: { url: 'chrome-extension://abc/index.html' } },
  ];
  for (const event of untrusted) {
    assert.throws(() => assertTrustedSender(event), /UNTRUSTED_SENDER/);
  }
});

test('every credential handler rejects untrusted senders without touching the store', () => {
  const { store } = makeStore();
  const ipcMain = fakeIpcMain();
  const backend = fakeBackend();
  registerIpc({ ipcMain, store, getBackend: () => backend });
  const evil = { senderFrame: { url: 'http://evil.example/' } };

  assert.throws(
    () => ipcMain.handlers.get('morphi:credentials:set')(evil, { providerId: 'openai', apiKey: 'sk-x' }),
    /UNTRUSTED_SENDER/,
  );
  assert.throws(
    () => ipcMain.handlers.get('morphi:credentials:delete')(evil, { providerId: 'openai' }),
    /UNTRUSTED_SENDER/,
  );
  assert.throws(() => ipcMain.handlers.get('morphi:credentials:status')(evil), /UNTRUSTED_SENDER/);
  assert.deepStrictEqual(store.status(), []);
  assert.deepStrictEqual(backend.child.messages, []);
});

test('never pushes before a backend child exists and survives postMessage failures', () => {
  const { store } = makeStore();
  const ipcMain = fakeIpcMain();
  let backend = null;
  registerIpc({ ipcMain, store, getBackend: () => backend });

  assert.deepStrictEqual(
    ipcMain.handlers.get('morphi:credentials:set')(trustedEvent(), { providerId: 'openai', apiKey: 'sk-x' }),
    { ok: true, persistent: true },
  );
  assert.strictEqual(store.get('openai'), 'sk-x');

  backend = { child: { postMessage() { throw new Error('child is gone'); } } };
  assert.doesNotThrow(() =>
    ipcMain.handlers.get('morphi:credentials:delete')(trustedEvent(), { providerId: 'openai' }),
  );
  assert.strictEqual(store.get('openai'), undefined);
});

test('rejects malformed credential arguments', () => {
  const { store } = makeStore();
  const ipcMain = fakeIpcMain();
  const backend = fakeBackend();
  registerIpc({ ipcMain, store, getBackend: () => backend });
  const set = ipcMain.handlers.get('morphi:credentials:set');

  const bad = [
    undefined,
    null,
    {},
    { providerId: 'openai' },
    { providerId: 'openai', apiKey: '' },
    { providerId: '', apiKey: 'sk-x' },
    { providerId: '__proto__', apiKey: 'sk-x' },
    { providerId: 'constructor', apiKey: 'sk-x' },
    { providerId: 'openai', apiKey: 42 },
  ];
  for (const args of bad) assert.throws(() => set(trustedEvent(), args), /INVALID_ARGUMENT/);
  assert.deepStrictEqual(store.status(), []);
  assert.deepStrictEqual(backend.child.messages, []);
});
