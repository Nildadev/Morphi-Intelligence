import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpillStore } from './store';
import { formatSpillNotice, hasSpillNotice, retainHeadTail } from './notice';

function tmpStore(): { store: SpillStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-spill-test-'));
  return { store: new SpillStore(dir), dir };
}

describe('SpillStore', () => {
  it('saves text and reads it back in slices', () => {
    const { store } = tmpStore();
    const content = 'hello world, this is a long result that should spill';
    const ref = store.saveText({
      owner: { sessionId: 'sess_1' },
      source: { kind: 'tool', toolName: 'search_game_tree', callId: 'call_1', label: 'result' },
      suggestedName: 'search_game_tree.txt',
      content,
    });
    expect(ref.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(ref.locator).toContain('sess_1');
    expect(fs.readFileSync(ref.locator, 'utf8')).toBe(content);

    const head = store.readSlice(ref.locator, 0, 11);
    expect(head.text).toBe('hello world');
    expect(head.totalChars).toBe(content.length);
    expect(head.nextOffset).toBe(11);

    const tail = store.readSlice(ref.locator, head.nextOffset ?? 0, 8000);
    expect(tail.text).toBe(content.slice(11));
    expect(tail.nextOffset).toBeNull();
  });

  it('sanitizes the suggested name and overwrites a retry locator', () => {
    const { store } = tmpStore();
    const first = store.saveText({
      owner: { sessionId: 's/1' },
      source: { kind: 'tool', toolName: 'search', callId: 'c1', label: 'result' },
      suggestedName: '../../etc/passwd.txt',
      content: 'first',
    });
    expect(first.locator).not.toContain('..');
    const second = store.saveText({
      owner: { sessionId: 's/1' },
      source: { kind: 'tool', toolName: 'search', callId: 'c1', label: 'result' },
      suggestedName: '../../etc/passwd.txt',
      content: 'second',
    });
    expect(second.locator).toBe(first.locator);
    expect(fs.readFileSync(second.locator, 'utf8')).toBe('second');
  });

  it('refuses to read outside the spill directory', () => {
    const { store } = tmpStore();
    expect(() => store.readSlice('/etc/passwd', 0, 10)).toThrow(/outside/);
    expect(() => store.readSlice('/tmp/other/file.txt', 0, 10)).toThrow(/outside/);
  });
});

describe('spill notice', () => {
  it('formats and recognizes the notice', () => {
    const ref = { locator: '/tmp/x.txt', bytes: 100, retrievalHint: 'Use read_spill.' };
    const notice = formatSpillNotice(80, ref, 100);
    expect(notice).toContain('Omitted 80 of 100');
    expect(notice).toContain('/tmp/x.txt');
    expect(hasSpillNotice(notice)).toBe(true);
    expect(hasSpillNotice('plain text')).toBe(false);
  });

  it('retains head and tail in order', () => {
    const text = 'A'.repeat(500) + 'B'.repeat(500) + 'C'.repeat(500);
    const notice = 'NOTICE';
    const preview = retainHeadTail(text, 120, notice);
    expect(preview.startsWith('A')).toBe(true);
    expect(preview.endsWith('NOTICE')).toBe(true);
    expect(preview).toContain('C');
    expect(preview.length).toBeLessThanOrEqual(120 + notice.length + 20);
  });

  it('leaves the original when the notice cannot fit', () => {
    const text = 'x'.repeat(10);
    // limit smaller than the notice: replacement disabled, original stays.
    expect(retainHeadTail(text, 2, 'this notice is very long')).toBe(text);
  });
});
