import type {
  AgentStatus,
  ApprovalRequest,
  DerivedApproval,
  DerivedMessage,
  DerivedStep,
  DerivedToolCall,
  EventPayloadMap,
  StreamEnvelope,
} from '../types';

/** How a turn settled (`turn/end reason`, server/src/harness/agent/loop.ts:241). Not an error by itself. */
export type TurnSettlement = EventPayloadMap['turn/end']['reason'];

/** `ApprovalRequest` plus the reducer-only turn it arrived on; `POST /api/approvals/:id` ignores it. */
export interface PendingApproval extends ApprovalRequest {
  turnId: string | null;
}

/**
 * Live text is provisional: a retried attempt re-streams under the same `turnId`, so the draft is
 * never rendered as history — only `messages` (durable rows) are. `assistant/message` reconciles the
 * draft by replacing it, never by appending to it.
 */
export interface ChatDraft {
  turnId: string;
  /** Id of the frame that opened this draft — a stable React key for the draft→durable handoff. */
  key: string;
  content: string;
  reasoning: string;
  /** Only for a call/approval that arrived before ANY durable row existed; folded in on `assistant/message`. */
  steps: DerivedStep[];
}

export interface ChatError {
  code: string;
  message?: string;
  retryable?: boolean;
}

export interface ChatState {
  /** Durable messages only — the same rows `GET /api/sessions/:id` returns, superseded ones dropped. */
  messages: DerivedMessage[];
  draft: ChatDraft;
  status: AgentStatus;
  pendingApproval: PendingApproval | null;
  /** Raw code is preserved; copy is the UI's job (Task 20 owns i18n). */
  error: ChatError | null;
  title: string | null;
  /** Steering messages waiting in the server inbox, oldest first; `position` is the inbox depth. */
  queued: { messages: string[]; position: number | null } | null;
  /** Last live line per call id, for the turn that is running: cleared by `turn/end`. */
  toolProgress: Record<string, string>;
  /** `turn/end` outcome, so a cancelled turn renders as stopped instead of failed. Reset by `turn/start`. */
  settled: TurnSettlement | null;
  /**
   * Persisted `seq` per durable row — the map `deriveMessages` keeps as `seqById`
   * (server/src/harness/session/projections.ts:17) and the only thing a `compaction/summary` frame can
   * match covered rows against. Rows seeded from a reload have no seq on the wire, and an unknown id is
   * left in place, exactly like projections.ts:58-60 skips an id it never recorded.
   */
  rowSeqById: Record<string, number>;
}

/** Synthetic frame the transport dispatches for a `202 { queued }` response — not a server envelope. */
export interface QueuedFrame {
  id?: string;
  type: 'transport/queued';
  payload: { position?: number; message?: string };
  ts?: number;
}

/** Synthetic frame after `POST /api/chat/queue/clear` confirmed the wait was dropped. */
export interface QueuedClearFrame {
  id?: string;
  type: 'transport/queued-clear';
  payload: { cleared?: number };
  ts?: number;
}

export type ChatAction = StreamEnvelope | QueuedFrame | QueuedClearFrame;

export function emptyDraft(turnId = '', key = ''): ChatDraft {
  return { turnId, key, content: '', reasoning: '', steps: [] };
}

export const initialChatState: ChatState = {
  messages: [],
  draft: emptyDraft(),
  status: 'idle',
  pendingApproval: null,
  error: null,
  title: null,
  queued: null,
  toolProgress: {},
  settled: null,
  rowSeqById: {},
};

const callStep = (step: DerivedStep): DerivedToolCall | undefined => (step.type === 'call' ? step.call : undefined);

const hasCall = (steps: DerivedStep[], callId: string) => steps.some((step) => callStep(step)?.callId === callId);

const hasApproval = (steps: DerivedStep[], approvalId: string) =>
  steps.some((step) => step.type === 'approval' && step.approval.approvalId === approvalId);

/** Adds `incoming` to `existing`, keeping position and letting the fresher copy win on a `callId` clash. */
function mergeSteps(existing: DerivedStep[], incoming: DerivedStep[]): DerivedStep[] {
  const out = [...existing];
  for (const step of incoming) {
    const callId = callStep(step)?.callId;
    const at = callId === undefined ? -1 : out.findIndex((s) => callStep(s)?.callId === callId);
    if (at === -1) out.push(step);
    else out[at] = step;
  }
  return out;
}

function replaceMessage(messages: DerivedMessage[], index: number, message: DerivedMessage): DerivedMessage[] {
  return messages.map((m, i) => (i === index ? message : m));
}

/**
 * The row a durable `tool/call` or `approval/request` belongs to. `deriveMessages` keeps a `current`
 * pointer that only a durable `user/message`/`assistant/message` moves (projections.ts:29,35) and pushes
 * the step onto (projections.ts:41,50), so the newest non-system durable row is the same thing here.
 */
function owningRowIndex(messages: DerivedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'system') return i;
  }
  return -1;
}

/** The projection's leading text step: `projections.ts:34` creates one whenever the row has content. */
function textStep(content: string): DerivedStep[] {
  return content ? [{ type: 'text', content }] : [];
}

/**
 * Pure reducer over the SSE envelope: no fetch, no timers, no clock reads.
 *
 * INVARIANT: for any event sequence the server can emit, `applyStreamEvent` over that sequence must end
 * in the same message/step structure `deriveMessages()` produces from those same events persisted as rows
 * (server/src/harness/session/projections.ts:12-78). Every branch below mirrors a projection line rather
 * than a guess about when a frame arrives.
 */
export function applyStreamEvent(state: ChatState, event: ChatAction): ChatState {
  switch (event.type) {
    case 'transport/queued': {
      const text = event.payload.message?.trim();
      const messages = [...(state.queued?.messages ?? []), ...(text ? [text] : [])];
      return { ...state, queued: { messages, position: event.payload.position ?? null } };
    }

    case 'transport/queued-clear':
      return state.queued === null ? state : { ...state, queued: null };

    case 'user/message': {
      const { messageId, content, source, attachments } = event.payload;
      const queued = source === 'steer' ? null : state.queued;
      if (state.messages.some((m) => m.id === messageId)) {
        return state.queued === queued ? state : { ...state, queued };
      }
      const message: DerivedMessage = {
        id: messageId,
        role: 'user',
        content,
        steps: [],
        // The frame's `ts` is the server's write time (http/sse.ts:36); a reload's `createdAt` is the
        // row's own insert time, so the two can differ by milliseconds — the structure is what must match.
        createdAt: event.ts,
        superseded: false,
        source,
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      };
      return {
        ...state,
        messages: [...state.messages, message],
        rowSeqById: { ...state.rowSeqById, [messageId]: event.seq },
        queued,
      };
    }

    case 'turn/start': {
      const { turnId, regeneratedFrom } = event.payload;
      // A regenerate's superseded row is FILTERED out of `GET /api/sessions/:id`
      // (projections.ts:73-77), so live drops it outright — flagging it would keep the old answer on
      // screen until a reload made it vanish. The whole previous turn goes with it (its thinking
      // and tool rows live on earlier assistant messages): keep everything up to the user message
      // that opened that turn.
      const dropped = regeneratedFrom?.supersedesAssistantMessageId;
      let messages = state.messages;
      if (dropped !== undefined) {
        const droppedIndex = messages.findIndex((m) => m.id === dropped);
        if (droppedIndex >= 0) {
          let userIndex = -1;
          for (let i = droppedIndex - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'user') { userIndex = i; break; }
          }
          messages = messages.slice(0, userIndex + 1);
        } else {
          messages = messages.filter((m) => m.id !== dropped);
        }
      }
      const rowSeqById = { ...state.rowSeqById };
      if (dropped !== undefined) delete rowSeqById[dropped];
      return {
        ...state,
        messages,
        rowSeqById,
        draft: emptyDraft(turnId, event.id),
        status: 'thinking',
        error: null,
        settled: null,
        // `queued` deliberately survives a turn boundary: the loop drains the inbox only at a step
        // boundary (`loop.ts:267`, index > 0), so an undrained steer really is still queued. No route
        // starts a turn with trigger `steer`, and the steer's own `user/message` row is what clears it.
        queued: state.queued,
      };
    }

    case 'assistant/delta': {
      const { turnId, text } = event.payload;
      const draft = state.draft.turnId === turnId ? state.draft : emptyDraft(turnId, event.id);
      return { ...state, draft: { ...draft, content: draft.content + text } };
    }

    case 'thought/delta': {
      const { turnId, text } = event.payload;
      const draft = state.draft.turnId === turnId ? state.draft : emptyDraft(turnId, event.id);
      return { ...state, draft: { ...draft, reasoning: draft.reasoning + text } };
    }

    case 'assistant/message': {
      const { messageId, content, reasoning, usage, activity } = event.payload;
      const index = state.messages.findIndex((m) => m.id === messageId);
      const existing = index === -1 ? undefined : state.messages[index];
      const mergedReasoning = reasoning ?? existing?.reasoning;
      const mergedUsage = usage ?? existing?.usage;
      // Keep the live row's React key across the handoff. Without it ChatView would unmount the
      // draft and mount a new row, cutting every word animation still in flight.
      const handoffKey = existing?.handoffKey ?? (state.draft.key !== '' ? state.draft.key : undefined);
      // projections.ts:34 seeds the row with its own text step and only then appends call/approval steps,
      // so the text step is always first — without it a live bubble loses text Task 23 renders from `steps`.
      const carried = (existing?.steps ?? []).filter((step) => step.type !== 'text');
      const message: DerivedMessage = {
        id: messageId,
        role: 'assistant',
        content,
        ...(mergedReasoning !== undefined ? { reasoning: mergedReasoning } : {}),
        steps: mergeSteps(textStep(content), [...carried, ...state.draft.steps]),
        ...(mergedUsage !== undefined ? { usage: mergedUsage } : {}),
        ...(activity !== undefined ? { activity } : {}),
        createdAt: event.ts,
        superseded: existing?.superseded ?? false,
        ...(handoffKey !== undefined ? { handoffKey } : {}),
      };
      return {
        ...state,
        messages: existing ? replaceMessage(state.messages, index, message) : [...state.messages, message],
        rowSeqById: { ...state.rowSeqById, [messageId]: event.seq },
        draft: emptyDraft(),
      };
    }

    // The server writes this step's durable `assistant/message` BEFORE it runs the tools
    // (loop.ts:296-308, `callIds` at :305, status at :322, pipeline at :323 → pipeline.ts:214-217), so a
    // mid-turn `tool/call` already has an owner on screen. Attaching by ownership (projections.ts:41)
    // instead of by turn state is what makes live and reload agree — see the invariant above.
    case 'tool/call': {
      const { callId, name, args, label } = event.payload;
      if (hasCall(state.draft.steps, callId) || state.messages.some((m) => hasCall(m.steps, callId))) {
        return state;
      }
      const step: DerivedStep = {
        type: 'call',
        call: { callId, name, args, ...(label ? { label } : {}), status: 'running' },
      };
      const index = owningRowIndex(state.messages);
      if (index === -1) {
        // Genuinely unrowed: no durable row exists to own it yet, so it waits on the draft and
        // `assistant/message` folds it in. Not the order the loop emits — a safety net for a partial log.
        return { ...state, draft: { ...state.draft, steps: [...state.draft.steps, step] } };
      }
      return {
        ...state,
        messages: replaceMessage(state.messages, index, {
          ...state.messages[index],
          steps: mergeSteps(state.messages[index].steps, [step]),
        }),
      };
    }

    case 'tool/result': {
      const { callId, status, result, durationMs } = event.payload;
      const patch = (call: DerivedToolCall): DerivedStep => ({
        type: 'call',
        call: { ...call, status, result, durationMs },
      });
      const draftAt = state.draft.steps.findIndex((s) => callStep(s)?.callId === callId);
      if (draftAt !== -1) {
        const steps = [...state.draft.steps];
        steps[draftAt] = patch(callStep(steps[draftAt])!);
        return { ...state, draft: { ...state.draft, steps } };
      }
      // The result belongs to whichever row carries the call — projections.ts:42-45 mutates that very
      // step. Live progress is NOT dropped here: loop.ts:443-452 emits the terminal `tool/progress`
      // frame right after this one, and `turn/end` is what clears the map.
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        const at = state.messages[i].steps.findIndex((s) => callStep(s)?.callId === callId);
        if (at === -1) continue;
        const steps = [...state.messages[i].steps];
        steps[at] = patch(callStep(steps[at])!);
        return { ...state, messages: replaceMessage(state.messages, i, { ...state.messages[i], steps }) };
      }
      return state;
    }

    case 'tool/progress': {
      const { callId, message } = event.payload;
      return { ...state, toolProgress: { ...state.toolProgress, [callId]: message } };
    }

    case 'approval/request': {
      const { approvalId, callId, name, args, risk } = event.payload;
      const pendingApproval: PendingApproval = {
        approvalId,
        callId,
        name,
        args,
        risk,
        // Reducer-only: the wire payload has no turnId (events/types.ts:17), and the draft knows the turn.
        turnId: state.draft.turnId === '' ? null : state.draft.turnId,
      };
      if (state.messages.some((m) => hasApproval(m.steps, approvalId)) || hasApproval(state.draft.steps, approvalId)) {
        return { ...state, pendingApproval };
      }
      const approval: DerivedApproval = { approvalId, callId, name, args, risk };
      const step: DerivedStep = { type: 'approval', approval };
      // projections.ts:46-50 pushes the approval onto the same `current` row a tool call attaches to, so
      // the timeline card exists live as well as after a reload.
      const index = owningRowIndex(state.messages);
      if (index === -1) {
        return { ...state, pendingApproval, draft: { ...state.draft, steps: [...state.draft.steps, step] } };
      }
      return {
        ...state,
        pendingApproval,
        messages: replaceMessage(state.messages, index, {
          ...state.messages[index],
          steps: mergeSteps(state.messages[index].steps, [step]),
        }),
      };
    }

    case 'approval/decision': {
      const { approvalId, decision } = event.payload;
      const pendingApproval = state.pendingApproval?.approvalId === approvalId ? null : state.pendingApproval;
      // projections.ts:51-54 settles the approval step in place; find it in the row (or the draft) that
      // carries it rather than assuming where it was pushed.
      const settle = (steps: DerivedStep[]): DerivedStep[] =>
        steps.map((step) =>
          step.type === 'approval' && step.approval.approvalId === approvalId
            ? { type: 'approval', approval: { ...step.approval, decision } }
            : step,
        );
      let messages = state.messages;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (!hasApproval(messages[i].steps, approvalId)) continue;
        messages = replaceMessage(messages, i, { ...messages[i], steps: settle(messages[i].steps) });
        break;
      }
      const draft = hasApproval(state.draft.steps, approvalId)
        ? { ...state.draft, steps: settle(state.draft.steps) }
        : state.draft;
      return { ...state, pendingApproval, messages, draft };
    }

    case 'session/title':
      return { ...state, title: event.payload.title };

    case 'session/revert': {
      // The server guards the branch boundary with `rowSeqById`; a reload is the authoritative
      // refetch after the route call, so here we only drop rows the live state knows are past it.
      const { toSeq } = event.payload;
      return {
        ...state,
        draft: emptyDraft(),
        status: 'idle',
        error: null,
        settled: null,
        pendingApproval: null,
        messages: state.messages.filter((message) => (state.rowSeqById[message.id] ?? Number.POSITIVE_INFINITY) <= toSeq),
      };
    }

    case 'agent/status': {
      const { state: status, turnId } = event.payload;
      // Adopt the turn into an empty draft so a status frame cannot wipe streamed text — but not after
      // the turn settled: loop.ts:249 pushes `idle` (and, for a cancel, `cancelled` at :242) AFTER
      // `turn/end`, and re-tagging then would hand a finished turn's id to the next draft.
      const draft = state.draft.turnId === '' && turnId && state.settled === null ? emptyDraft(turnId, event.id) : state.draft;
      return { ...state, status, draft };
    }

    case 'turn/end': {
      // `reason` is recorded, never interpreted: a user cancel carries no error and must not gain one
      // (ruling 1), but loop.ts:249 pushes `agent/status idle` after it whatever the reason was, so the
      // UI can only tell "stopped" from "finished" from `settled`. Live progress is per turn.
      // The durable payload carries the provider failure too (server events/types.ts), so the error
      // card survives a reload instead of being a live-only memory.
      const error = event.payload.error;
      return {
        ...state,
        draft: emptyDraft(),
        status: 'idle',
        settled: event.payload.reason,
        toolProgress: {},
        ...(error !== undefined ? { error: { ...error } } : {}),
      };
    }

    case 'compaction/summary': {
      // The same splice-and-insert `deriveMessages` performs (projections.ts:55-69): rows whose persisted
      // seq falls inside the covered range disappear from `GET /api/sessions/:id`, replaced by one
      // `summary_<seq>` system row inserted ahead of the first survivor past the range.
      const { summary, coveredFrom, coveredTo } = event.payload;
      const covered = (id: string) => {
        const seq = state.rowSeqById[id];
        return seq !== undefined && seq >= coveredFrom && seq <= coveredTo;
      };
      const kept = state.messages.filter((message) => !covered(message.id));
      const summaryMessage: DerivedMessage = {
        id: `summary_${event.seq}`,
        role: 'system',
        content: summary,
        steps: [],
        createdAt: event.ts,
        superseded: false,
      };
      const insertAt = kept.findIndex(
        (message) => !message.id.startsWith('summary_') && (state.rowSeqById[message.id] ?? 0) > coveredTo,
      );
      const messages = insertAt === -1
        ? [...kept, summaryMessage]
        : [...kept.slice(0, insertAt), summaryMessage, ...kept.slice(insertAt)];
      const rowSeqById = { ...state.rowSeqById, [summaryMessage.id]: event.seq };
      for (const message of state.messages) if (covered(message.id)) delete rowSeqById[message.id];
      return { ...state, messages, rowSeqById };
    }

    case 'error': {
      const { code, message, retryable } = event.payload;
      return { ...state, error: { code, message, retryable } };
    }

    default:
      // session/created, session/skills, step/start, assistant/attempt, goal/*, subagent/*,
      // workflow/*, mcp/status: none of them mutate `messages`, so ignoring them cannot diverge from a
      // reload. Anything that does touch the transcript (compaction/summary above) has to be mirrored.
      return state;
  }
}
