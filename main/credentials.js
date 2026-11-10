const fs = require('node:fs');
const path = require('node:path');

// Provider ids are app-defined slugs, optionally namespaced (`custom:<slug>`).
// Restricting them keeps the JSON map free of prototype keys such as `__proto__`.
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;
const RESERVED_PROVIDER_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidProviderId(providerId) {
  return (
    typeof providerId === 'string' &&
    PROVIDER_ID_PATTERN.test(providerId) &&
    !RESERVED_PROVIDER_IDS.has(providerId)
  );
}

function createCredentialStore({ safeStorage, filePath, memory: sessionMemory } = {}) {
  const persistent = Boolean(
    safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable(),
  );
  const memory = sessionMemory instanceof Map ? sessionMemory : new Map();

  const read = () => {
    if (!persistent) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const write = (data) => {
    if (!persistent) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // `mode` only applies on creation; chmod covers pre-existing files (best effort, a no-op on Windows).
    fs.writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best effort */
    }
  };

  const get = (providerId) => {
    if (!persistent) return memory.get(providerId);
    const value = read()[providerId];
    if (typeof value !== 'string' || value === '') return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      // A key encrypted under another OS user/profile cannot be decrypted; treat it as absent.
      return undefined;
    }
  };

  return {
    persistent,
    set(providerId, apiKey) {
      if (!isValidProviderId(providerId)) throw new Error('INVALID_PROVIDER_ID');
      if (typeof apiKey !== 'string' || apiKey === '') throw new Error('INVALID_API_KEY');
      if (!persistent) {
        memory.set(providerId, apiKey);
        return;
      }
      const data = read();
      data[providerId] = safeStorage.encryptString(apiKey).toString('base64');
      write(data);
    },
    get,
    delete(providerId) {
      memory.delete(providerId);
      if (!persistent) return;
      const data = read();
      if (!Object.prototype.hasOwnProperty.call(data, providerId)) return;
      delete data[providerId];
      write(data);
    },
    all() {
      if (!persistent) return Object.fromEntries(memory);
      const keys = {};
      for (const providerId of Object.keys(read())) {
        const apiKey = get(providerId);
        if (apiKey !== undefined) keys[providerId] = apiKey;
      }
      return keys;
    },
    status() {
      const ids = persistent ? Object.keys(read()) : [...memory.keys()];
      return ids.map((providerId) => ({ providerId, configured: true }));
    },
  };
}

module.exports = { createCredentialStore, isValidProviderId };
