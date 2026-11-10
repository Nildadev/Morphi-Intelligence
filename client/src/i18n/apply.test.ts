import { describe, expect, it } from 'vitest';
import { applyUiLanguage, vi } from './vi';

describe('applyUiLanguage', () => {
  it('swaps the live dictionary to English and back to Vietnamese', () => {
    expect(vi.nav.newChat).toBe('Cuộc trò chuyện mới');
    applyUiLanguage('en');
    expect(vi.nav.newChat).toBe('New chat');
    expect(vi.settings.themeSection).toBe('Theme');
    applyUiLanguage('vi');
    expect(vi.nav.newChat).toBe('Cuộc trò chuyện mới');
    expect(vi.settings.themeSection).toBe('Giao diện');
  });
});
