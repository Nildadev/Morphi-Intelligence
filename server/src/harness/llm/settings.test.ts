import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { createProviderSettingsStore } from './settings';

describe('provider settings store', () => {
  it('hides the retired proxypal row from the boot replay', () => {
    const db = createTestDb();
    try {
      const store = createProviderSettingsStore(db);
      store.setConfig('proxypal', { enabled: false });
      store.setConfig('openai', { enabled: true });

      expect(store.list().map((setting) => setting.providerId)).toEqual(['openai']);
    } finally {
      db.close();
    }
  });
});