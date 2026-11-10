import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSE_PING_INTERVAL_MS, sseHeaders, startSSEPing, writeSSE } from './sse';

interface FakeRes {
  res: Response;
  writes: string[];
}

function fakeRes(): FakeRes {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as Response;
  return { res, writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('writeSSE', () => {
  it('writes the binding envelope: generated id, passed seq, type, payload, ts', () => {
    const { res, writes } = fakeRes();
    writeSSE(res, { seq: 7, type: 'turn/end', payload: { turnId: 'turn_1', reason: 'completed' } });
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n\n')).toBe(true);
    const frame = JSON.parse(writes[0].slice('data: '.length, -2));
    expect(frame).toEqual({
      id: expect.stringMatching(/^evt_/),
      seq: 7,
      type: 'turn/end',
      payload: { turnId: 'turn_1', reason: 'completed' },
      ts: expect.any(Number),
    });
  });

  it('keeps an explicit id and drops writes to an ended response', () => {
    const { res, writes } = fakeRes();
    writeSSE(res, { id: 'evt_42', type: 'assistant/delta', payload: { text: 'x' } });
    expect(JSON.parse(writes[0].slice('data: '.length)).id).toBe('evt_42');
    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    writeSSE(res, { type: 'assistant/delta', payload: { text: 'y' } });
    expect(writes).toHaveLength(1);
  });
});

describe('sseHeaders', () => {
  it('sets the four stream headers on status 200 and flushes before the first frame', () => {
    const headers: Record<string, string> = {};
    let status: number | undefined;
    let flushed = false;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      flushHeaders() {
        flushed = true;
      },
    } as unknown as Response;

    sseHeaders(res);

    expect(status).toBe(200);
    expect(flushed).toBe(true);
    expect(headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });
});

describe('startSSEPing', () => {
  it('emits a ping comment on the interval and stops after the returned clear', () => {
    vi.useFakeTimers();
    const { res, writes } = fakeRes();
    const stop = startSSEPing(res);
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS * 2 + 1);
    expect(writes).toEqual([': ping\n\n', ': ping\n\n']);
    stop();
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS * 3);
    expect(writes).toHaveLength(2);
  });

  it('never writes to an ended or destroyed response', () => {
    vi.useFakeTimers();
    const { res, writes } = fakeRes();
    const stop = startSSEPing(res);
    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS);
    (res as unknown as { writableEnded: boolean }).writableEnded = false;
    (res as unknown as { destroyed: boolean }).destroyed = true;
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS);
    stop();
    expect(writes).toHaveLength(0);
  });
});
