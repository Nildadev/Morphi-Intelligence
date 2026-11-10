import type { Response } from 'express';
import { createId } from '../harness/shared/id';

export const SSE_PING_INTERVAL_MS = 15_000;

export interface SSEFrame {
  id?: string;
  seq?: number;
  type: string;
  payload: unknown;
}

export function sseHeaders(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Electron reaches the server through proxies that buffer by default; without this the stream
  // only flushes at turn end and every frame arrives as one block.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/**
 * The single SSE envelope every client parses: durable rows carry the persisted `seq`, live frames
 * carry none, and both carry a de-duplicable `id`. A write to an ended response is dropped silently
 * — a client that vanished mid-turn must never crash the turn that is still writing.
 */
export function writeSSE(res: Response, event: SSEFrame): void {
  if (res.writableEnded || res.destroyed) return;
  const frame = {
    id: event.id ?? createId('evt'),
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    ts: Date.now(),
  };
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

/** Keep-alive comment frames; the returned function clears the interval once the turn ends. */
export function startSSEPing(res: Response): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, SSE_PING_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
