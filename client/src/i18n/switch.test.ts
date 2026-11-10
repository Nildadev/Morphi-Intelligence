import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { vi } from './vi';
import { getUiLanguage, setUiLanguage } from '../lib/prefs';

describe('ui language switch end-to-end', () => {
  it('shows the English settings title after choosing English', async () => {
    setUiLanguage('en');
    expect(getUiLanguage()).toBe('en');
    // Simulate the App render-phase application.
    const { applyUiLanguage } = await import('./vi');
    applyUiLanguage('en');
    expect(vi.settings.title).toBe('Settings');
    applyUiLanguage('vi');
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
