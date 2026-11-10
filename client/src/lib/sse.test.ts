import { describe, expect, it } from 'vitest';
import { createSSEParser } from './sse';

describe('createSSEParser', () => {
  it('handles chunk boundaries and multiple data lines', () => {
    const seen: string[] = [];
    const feed = createSSEParser((data) => seen.push(data));
    feed('data: {"a":');
    feed('1}\n\ndata: {"b":2}\n\n');
    feed('data: {"c":3}', true);
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
