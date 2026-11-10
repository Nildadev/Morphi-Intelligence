import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AGENT_ERROR_CODE } from '../harness/agent/loop';
import type { AgentTurnInput, ChatAttachmentInput } from '../harness/agent/loop';
import { createEmit } from '../harness/events/emit';
import type { EventPayloadMap } from '../harness/events/types';
import type { Harness } from '../harness/harness';
import { api, HttpError, parseWith } from '../http/validation';
import { redact } from '../http/redact';
import { sseHeaders, startSSEPing, writeSSE } from '../http/sse';
import { DEFAULT_TITLE } from './sessions';

const attachmentSchema = z.object({
  name: z.string().min(1).max(260),
  mime: z.string().min(1).max(120),
  size: z.number().int().min(0).max(50 * 1024 * 1024),
  data: z.string().min(1).max(70 * 1024 * 1024),
});

const streamSchema = z
  .strictObject({
    sessionId: z.string().trim().min(1).max(120),
    message: z.string().trim().max(200_000),
    model: z.string().trim().min(1).max(160).optional(),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    permissionMode: z.enum(['ask', 'balanced', 'full']).optional(),
    language: z.enum(['vi', 'en']).optional(),
    attachments: z.array(attachmentSchema).max(12).optional(),
  })
  // An image-only turn is a real turn: the pixels are the message. Empty text is refused only when
  // nothing rides along, so a bare `{ message: '' }` still 400s instead of opening an empty turn.
  .refine((input) => input.message.length > 0 || (input.attachments?.length ?? 0) > 0, {
    path: ['message'],
    message: 'message or attachments is required',
  });

const regenerateSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(120),
  assistantMessageId: z.string().trim().min(1).max(120),
  language: z.enum(['vi', 'en']).optional(),
});

const cancelSchema = z.strictObject({ sessionId: z.string().trim().min(1).max(120) });

/**
 * Pre-stream provider probe: `runTurn` reports resolution failure as a mid-stream error frame, but
 * with nothing configured there is no turn worth streaming — answer JSON before any header lands.
 */
function assertProvider(harness: Harness, modelSelection: string): void {
  try {
    harness.llm.resolve(modelSelection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, 'NO_PROVIDER', message);
  }
}

interface TurnSinkState {
  turnId?: string;
  turnEnded: boolean;
  /** Failed provider attempts in the current step; >0 means live deltas are replayed text. */
  attempts: number;
}

/**
 * Persist-and-stream sink for one turn. Durable writes go through the event store first, so a row
 * that cannot be persisted (the memory-clear case) throws out of `runTurn` — the caller catches it
 * and ends the stream; nothing here may swallow that error, or the loop keeps paying a provider for
 * a session that no longer exists.
 */
function createTurnSink(res: Response, harness: Harness, sessionId: string): { state: TurnSinkState; emit: ReturnType<typeof createEmit> } {
  const state: TurnSinkState = { turnEnded: false, attempts: 0 };
  const emit = createEmit(harness.events, sessionId, (event) => {
    if ('seq' in event) {
      if (event.type === 'turn/start') state.turnId = (event.payload as EventPayloadMap['turn/start']).turnId;
      if (event.type === 'turn/end') state.turnEnded = true;
      if (event.type === 'step/start') state.attempts = 0;
      if (event.type === 'assistant/attempt') state.attempts += 1;
      writeSSE(res, { id: `evt_${event.id}`, seq: event.seq, type: event.type, payload: event.payload });
      return;
    }
    // A retryable provider failure re-streams the same step from scratch under the same `turnId`
    // with no attempt marker, so concatenating both attempts' deltas shows partial-then-restart.
    // Drop the replay instead: the live view keeps the failed partial, and the durable
    // `assistant/message` (only the successful attempt is persisted) is authoritative on reload.
    if (state.attempts > 0 && (event.type === 'assistant/delta' || event.type === 'thought/delta')) return;
    writeSSE(res, { type: event.type, payload: event.payload });
  });
  return { state, emit };
}

/**
 * Own the registry entry for exactly one turn (Task 17 contract): `start` before dispatch, `finish`
 * in the `finally`, so `harness.busy()` and `POST /cancel` work against this session from the first
 * frame. There must be no await between the caller's busy check and the `start` here.
 */
async function runStreamedTurn(req: Request, res: Response, harness: Harness, input: Omit<AgentTurnInput, 'signal'>): Promise<void> {
  const controller = harness.cancellations.start(input.sessionId);
  // The `finally` below owns every resource acquired here, so the `try` opens as soon as the first
  // one (the registry entry) exists — otherwise a throw while writing headers or starting the ping
  // would leak the entry (leaving the session permanently busy) and the ping interval.
  let state: TurnSinkState | undefined;
  let stopPing: (() => void) | undefined;
  let onClose: (() => void) | undefined;
  try {
    const sink = createTurnSink(res, harness, input.sessionId);
    state = sink.state;
    sseHeaders(res);
    stopPing = startSSEPing(res);
    onClose = () => {
      // Client vanished before `turn/end`: abort cooperatively so the loop stops paying for a
      // stream nobody reads. After `turn/end` the entry is ours to release normally.
      if (!sink.state.turnEnded) controller.abort();
    };
    // Listen on the response, not the request: `express.json()` consumes the body, so the request
    // stream has already emitted its single `close` by the time this handler attaches and would
    // never hear a real disconnect. `res` closes when the socket drops mid-stream, which is the
    // event that must abort the turn; the `finally` below still owns every release (registry, ping,
    // listener, response), this handler only signals the abort the cooperative `cancel` path uses.
    res.on('close', onClose);
    await harness.agent.runTurn({ ...input, signal: controller.signal }, sink.emit);
  } catch (error) {
    // Only reachable when a durable write threw out of the loop — today that means the session row
    // was deleted (memory clear / session delete) while the turn was live. End the stream the way
    // the loop would have: an error frame plus a terminal `turn/end`, never a crash.
    if (state && !state.turnEnded) {
      const message = error instanceof Error ? error.message : String(error);
      writeSSE(res, { type: 'error', payload: { code: AGENT_ERROR_CODE, message: redact(message), retryable: false } });
      if (state.turnId) {
        writeSSE(res, { type: 'turn/end', payload: { turnId: state.turnId, reason: 'error' } });
        writeSSE(res, { type: 'agent/status', payload: { state: 'idle', turnId: state.turnId } });
      }
    }
  } finally {
    if (onClose) res.removeListener('close', onClose);
    if (stopPing) stopPing();
    harness.cancellations.finish(input.sessionId, controller);
    if (!res.writableEnded) res.end();
  }
}

export function createChatRouter(harness: Harness): Router {
  const router = Router();

  router.post('/stream', api(async (req, res) => {
    const input = parseWith(streamSchema, req.body, 'body');
    const session = harness.sessions.get(input.sessionId);
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND');

    if (harness.busy(input.sessionId)) {
      // A second message while a turn runs is steering, not a rival turn: queue it for the loop's
      // next step boundary instead of opening a second stream. Echo the queue position and the
      // trimmed text so the client card can show exactly what is waiting, not just that some is.
      const position = harness.inbox.push(input.sessionId, input.message);
      res.status(202).json({ queued: true, position, message: input.message });
      return;
    }

    const modelSelection = input.model ?? session.modelSelection ?? 'auto';
    if (input.model) harness.sessions.updateModelSelection(input.sessionId, input.model);
    assertProvider(harness, modelSelection);

    if (session.title === DEFAULT_TITLE && input.message.length > 0) {
      // Name the session without pausing the stream; when the response has already ended the client
      // picks the title up from the session list after `turn/end`. An image-only first turn keeps the
      // default title: there is no text to name it from, and an empty prompt titles garbage.
      harness.titles
        .generate(input.message)
        .then((title) => {
          // Re-check the still-default title here: `rename` is an unconditional UPDATE, so a manual
          // rename landing while the generation was in flight must win over the auto title.
          const current = harness.sessions.get(input.sessionId);
          if (!current || current.title !== DEFAULT_TITLE) return;
          const row = harness.sessions.rename(input.sessionId, title, 'auto');
          writeSSE(res, { id: `evt_${row.id}`, seq: row.seq, type: row.type, payload: row.payload });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[http] auto-title generation failed', redact(message));
        });
    }

    await runStreamedTurn(req, res, harness, {
      sessionId: input.sessionId,
      content: input.message,
      modelSelection,
      trigger: 'user',
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    });
  }));

  router.post('/cancel', api((req, res) => {
    const { sessionId } = parseWith(cancelSchema, req.body, 'body');
    // Idempotent stop: cancelling a session that finished between keystroke and click is a no-op,
    // not an error, and the task-18 stream owns its own `finish`.
    const cancelled = harness.cancellations.cancel(sessionId);
    res.json({ sessionId, cancelled });
  }));

  // Drop every steering message still waiting in the inbox (the queue card's dismiss control).
  // Messages the loop has already drained are durable steer rows and stay; clearing only owns
  // what has not been consumed yet. Idempotent: an empty inbox clears to 0, not an error.
  router.post('/queue/clear', api((req, res) => {
    const { sessionId } = parseWith(cancelSchema, req.body, 'body');
    if (!harness.sessions.get(sessionId)) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const cleared = harness.inbox.clear(sessionId);
    res.json({ sessionId, cleared });
  }));

  router.post('/regenerate', api(async (req, res) => {
    const input = parseWith(regenerateSchema, req.body, 'body');
    const detail = harness.sessions.get(input.sessionId);
    if (!detail) throw new HttpError(404, 'SESSION_NOT_FOUND');
    // A regenerate replaces an answer; it is never steering, so a busy session refuses it outright.
    if (harness.busy(input.sessionId)) throw new HttpError(409, 'SESSION_BUSY', 'phiên đang bận');

    const index = detail.messages.findIndex((message) => message.id === input.assistantMessageId);
    // Only an assistant row is a valid regenerate anchor: a user id would anchor the backwards scan
    // on an earlier user message and persist it as `supersedesAssistantMessageId`, hiding a user turn.
    if (index === -1 || detail.messages[index].role !== 'assistant') throw new HttpError(404, 'MESSAGE_NOT_FOUND');
    let userMessageId: string | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (detail.messages[cursor].role === 'user') {
        userMessageId = detail.messages[cursor].id;
        break;
      }
    }
    if (!userMessageId) throw new HttpError(400, 'VALIDATION_ERROR', 'assistant message has no preceding user message');

    const modelSelection = detail.modelSelection ?? 'auto';
    assertProvider(harness, modelSelection);

    // No `content`: the loop must not append a second copy of the user message — `regeneratedFrom`
    // supersedes the old assistant answer in the projection instead.
    await runStreamedTurn(req, res, harness, {
      sessionId: input.sessionId,
      modelSelection,
      trigger: 'regenerate',
      ...(input.language === undefined ? {} : { language: input.language }),
      regeneratedFrom: { userMessageId, supersedesAssistantMessageId: input.assistantMessageId },
    });
  }));

  return router;
}
