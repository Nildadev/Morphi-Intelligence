import { describe, expect, it } from 'vitest';
import { formatContextWindow, plainTitle } from './utils';

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
