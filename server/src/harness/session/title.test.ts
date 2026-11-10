import { describe, expect, it, vi } from 'vitest';
import { cleanTitle, fallbackTitle, TitleService } from './title';

describe('cleanTitle', () => {
  it('strips markdown markers so a title is always plain text', () => {
    expect(cleanTitle('**Hệ Thống Combat**')).toBe('Hệ Thống Combat');
    expect(cleanTitle('## Kế hoạch')).toBe('Kế hoạch');
    expect(cleanTitle('__Debug__ `placement`')).toBe('Debug placement');
    expect(cleanTitle('[docs](https://example.test)')).toBe('docs');
  });
});

describe('fallbackTitle', () => {
  it('keeps at most the first five words', () => {
    expect(fallbackTitle('one two three four five six seven')).toBe('one two three four five');
  });

  it('collapses whitespace and trims the input', () => {
    expect(fallbackTitle('  hello\n\n  world\tfoo  ')).toBe('hello world foo');
  });

  it('returns the default title for empty input', () => {
    expect(fallbackTitle('')).toBe('New conversation');
    expect(fallbackTitle('   \n\t ')).toBe('New conversation');
  });
});

describe('TitleService', () => {
  it('returns the cleaned title and passes the prompt and model to the completer', async () => {
    const complete = vi.fn(async () => '  "Quarterly revenue report"  ');
    const service = new TitleService(complete, 'fast-model');

    await expect(service.generate('summarize q3 numbers')).resolves.toBe(
      'Quarterly revenue report',
    );
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining('Generate a concise 4-5 word title for: summarize q3 numbers'),
      'fast-model',
    );
  });

  it('strips single wrapping quotes', async () => {
    const service = new TitleService(async () => "'Tight title'", 'fast-model');

    await expect(service.generate('anything')).resolves.toBe('Tight title');
  });

  it('falls back when the generated title is empty', async () => {
    const service = new TitleService(async () => '   ', 'fast-model');

    await expect(service.generate('plan a beach trip')).resolves.toBe('plan a beach trip');
  });

  it('falls back when the generated title is longer than 60 characters', async () => {
    const complete = vi.fn(async () => 'x'.repeat(61));
    const service = new TitleService(complete, 'fast-model');

    await expect(service.generate('buy milk and eggs today')).resolves.toBe(
      'buy milk and eggs today',
    );
    expect(complete).toHaveBeenCalled();
  });

  it('strips markdown from a disobedient model title instead of storing it', async () => {
    const service = new TitleService(async () => '**Hệ Thống Combat**', 'fast-model');

    await expect(service.generate('Tạo hệ thống combat')).resolves.toBe('Hệ Thống Combat');
  });

  it('falls back when the completer rejects', async () => {
    const service = new TitleService(async () => {
      throw new Error('offline');
    }, 'fast-model');

    await expect(service.generate('debug the parser')).resolves.toBe('debug the parser');
  });
});
