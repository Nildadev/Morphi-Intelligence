import { describe, expect, it } from 'vitest';
import { parseSSEChunk } from './sse';

describe('parseSSEChunk', () => {
  it('returns every complete data line in a chunk', () => {
    const result = parseSSEChunk('', 'data: {"a":1}\ndata: {"b":2}\n\n');

    expect(result.data).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.rest).toBe('');
  });

  it('keeps a partial line in rest and reassembles it on the next chunk', () => {
    const first = parseSSEChunk('', 'data: {"choices":[{"delta":{"content":"hel');

    expect(first.data).toEqual([]);
    expect(first.rest).toBe('data: {"choices":[{"delta":{"content":"hel');

    const second = parseSSEChunk(first.rest, 'lo"}}]}\n\n');

    expect(second.data).toEqual(['{"choices":[{"delta":{"content":"hello"}}]}']);
    expect(second.rest).toBe('');
  });

  it('trims CRLF line endings', () => {
    const result = parseSSEChunk('', 'data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n');

    expect(result.data).toEqual(['{"a":1}', '[DONE]']);
    expect(result.rest).toBe('');
  });

  it('flushes a final data line that has no trailing newline exactly once', () => {
    const result = parseSSEChunk('data: {"a":1}', '', true);

    expect(result.data).toEqual(['{"a":1}']);
    expect(result.rest).toBe('');
  });

  it('flushes complete lines plus a partial tail without duplicating payloads', () => {
    const result = parseSSEChunk('', 'data: {"a":1}\ndata: {"b":2}', true);

    expect(result.data).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.rest).toBe('');
  });

  it('does not duplicate a complete line that already ends with a newline', () => {
    const result = parseSSEChunk('', 'data: {"a":1}\n', true);

    expect(result.data).toEqual(['{"a":1}']);
    expect(result.rest).toBe('');
  });

  it('ignores non-data lines such as SSE comments', () => {
    const result = parseSSEChunk('', ': keep-alive\n\ndata: 1\n');

    expect(result.data).toEqual(['1']);
  });
});
