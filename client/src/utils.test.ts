import { describe, expect, it } from 'vitest';
import { cn, formatContextWindow, plainTitle } from './utils';

/**
 * Regression guard for the root cause of "chữ bị to" (oversized status labels).
 *
 * `text-ui-*` are custom font-size tokens from `@theme`. tailwind-merge's DEFAULT config has a
 * catch-all `text-color` group, so `cn('text-ui-sm', 'text-success-text')` used to be read as
 * "two colours" and the SIZE was silently dropped — the label then rendered at the inherited
 * 15px body size. The fix registers the custom scale as a `font-size` group in `utils.ts`.
 * These assertions pin the exact pairs that used to fail, plus the merge semantics that must
 * NOT change (two sizes / two colours still collapse, last wins).
 */
describe('cn — custom typography tokens survive tailwind-merge', () => {
  it('keeps a custom font-size next to a custom text colour', () => {
    const result = cn('shrink-0 text-ui-xs font-medium', 'text-success-text');
    expect(result).toContain('text-ui-xs');
    expect(result).toContain('text-success-text');
    expect(result).toContain('font-medium');
  });

  it.each([
    'text-ui-2xs', 'text-ui-xs', 'text-ui-sm', 'text-ui-caption',
    'text-ui-base', 'text-ui-lg', 'text-ui-xl',
    'text-ui-settings-title', 'text-ui-settings-title-lg', 'text-mobile-input-safe',
  ])('keeps %s alongside a colour token', (level) => {
    expect(cn(level, 'text-text-secondary')).toContain(level);
    expect(cn('text-text-secondary', level)).toContain(level);
  });

  it('does not let a standard palette colour evict a custom size', () => {
    expect(cn('text-ui-sm', 'text-red-500')).toContain('text-ui-sm');
    expect(cn('text-red-500', 'text-ui-sm')).toContain('text-ui-sm');
  });

  it('still collapses two competing sizes to the last one', () => {
    expect(cn('text-ui-xs', 'text-ui-sm')).toBe('text-ui-sm');
    expect(cn('text-sm', 'text-lg')).toBe('text-lg');
  });

  it('still collapses two competing colours to the last one', () => {
    expect(cn('text-success-text', 'text-danger-text')).toBe('text-danger-text');
  });
});

/**
 * Task 31C — the model picker prints each model's declared context, so a per-model window is
 * visible instead of implied. The formatter is the only place that rounds, and it never invents a
 * number for a model that declared none.
 */
describe('formatContextWindow', () => {
  it.each([
    [1_048_576, '1M'],
    [1_000_000, '1M'],
    [2_000_000, '2M'],
    [1_500_000, '1.5M'],
    [200_000, '200k'],
    [128_000, '128k'],
    [32_768, '32k'],
    [8_191, '8k'],
  ])('renders %i tokens as %s', (tokens, expected) => {
    expect(formatContextWindow(tokens)).toBe(expected);
  });

  it('renders nothing for a model that declared no context', () => {
    expect(formatContextWindow(0)).toBe('');
    expect(formatContextWindow(-1)).toBe('');
    expect(formatContextWindow(Number.NaN)).toBe('');
  });

  it('never rounds a tiny window down to 0k', () => {
    expect(formatContextWindow(500)).toBe('1k');
  });
});

describe('plainTitle', () => {
  it('strips the light markdown auto-titles sometimes carry', () => {
    expect(plainTitle('**Chào Bạn**')).toBe('Chào Bạn');
    expect(plainTitle('## Kế hoạch triển khai')).toBe('Kế hoạch triển khai');
    expect(plainTitle('`debug` placement')).toBe('debug placement');
  });

  it('leaves a plain title untouched', () => {
    expect(plainTitle('Combat System Framework')).toBe('Combat System Framework');
  });
});
