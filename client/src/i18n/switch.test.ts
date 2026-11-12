import { describe, expect, it } from 'vitest';
import { vi } from './vi';
import { getUiLanguage, setUiLanguage } from '../lib/prefs';

describe('ui language switch end-to-end', () => {
  it('swaps the dictionary itself when the preference changes', async () => {
    // The swap happens inside the setter, not in a component: a language pick must not depend on which
    // component happens to render next, and applying it during render is a side effect React forbids.
    setUiLanguage('en');
    expect(getUiLanguage()).toBe('en');
    expect(vi.settings.title).toBe('Settings');
    setUiLanguage('vi');
    expect(vi.settings.title).toBe('Cài đặt');
  });

  it('dict swap is observable through the shared module object', async () => {
    const live = vi;
    const { applyUiLanguage } = await import('./vi');
    applyUiLanguage('en');
    expect(live.settings.title).toBe('Settings');
    expect(live.nav.newChat).toBe('New chat');
    applyUiLanguage('vi');
    expect(live.settings.title).toBe('Cài đặt');
  });
});
