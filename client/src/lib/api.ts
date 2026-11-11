import type {
  ApiErrorEnvelope,
  ApprovalDecisionBody,
  ApprovalDecisionResult,
  ChatCancelResult,
  ChatQueuedResponse,
  ChatQueueClearResult,
  ChatRegenerateBody,
  ChatStreamBody,
  GoalClearResult,
  GoalSetResult,
  McpStatus,
  MemoryClearResult,
  MemoryStats,
  ModelInfo,
  PlanClearResult,
  PlanSetResult,
  Project,
  ProviderConfigBody,
  ProviderConnectResult,
  ProviderBridgeStatus,
  ProviderStatus,
  RestorePreview,
  RestoreResult,
  SessionDeleteResult,
  SessionDetail,
  SessionPinResult,
  SessionSummary,
  SearchPage,
  SkillMeta,
  StreamEnvelope,
  SubagentInterruptResult,
  SubagentRunResult,
  SubagentTreeEntry,
  ToolMetadata,
  ToolToggleResult,
  TurnRestoreResult,
  WorkspaceCheckpoint,
} from '../types';
import { getToken } from './token';
import { createSSEParser } from './sse';
import type { ChatAction, QueuedFrame } from './chatReducer';

/**
 * Relative base: Vite proxies `/api` to the local server in dev, and the
 * Electron host serves the client from the same origin as the API. Nothing in
 * this file may build an absolute origin — that would break both.
 */
const API_BASE = '/api';

/**
 * Authenticated fetch wrapper: every request carries the preload-issued token
 * in `X-Morphi-Token`. The token never becomes part of a URL.
 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set('X-Morphi-Token', token);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

/** Codes the transport invents when no server envelope exists to read. Task 20/23 own the copy. */
export const TRANSPORT_ERROR_CODE = 'TRANSPORT_ERROR';
export const UNEXPECTED_RESPONSE_CODE = 'UNEXPECTED_RESPONSE';

/**
 * An HTTP or transport failure. `code` is the raw `error.code` of the unified envelope
 * (`server/src/http/validation.ts`, `HttpError.body()`), never a stringified message: the surface is
 * `code`-driven (401/404/409 stay distinguishable), and copy is the UI's job.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** One SSE envelope (or a synthetic transport frame) delivered in server order. */
export type StreamHandler = (frame: ChatAction) => void;

interface ErrorResponseShape {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/** `{ error: { code, message?, details? } }` and nothing else — a flat `error: 'CODE'` is not read. */
function envelopeOf(parsed: unknown): ErrorResponseShape | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const error = (parsed as ApiErrorEnvelope).error;
  return typeof error === 'object' && error !== null ? error as ErrorResponseShape : undefined;
}

async function apiErrorOf(response: Response): Promise<ApiError> {
  const parsed: unknown = await response.json().catch(() => undefined);
  const envelope = envelopeOf(parsed);
  const code = typeof envelope?.code === 'string' && envelope.code !== ''
    ? envelope.code
    // No envelope to read (a proxy page, a bodyless 5xx): the status is all the client can know.
    : `HTTP_${response.status}`;
  return new ApiError(
    response.status,
    code,
    typeof envelope?.message === 'string' ? envelope.message : undefined,
    envelope?.details,
  );
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return search === '' ? path : `${path}?${search}`;
}

/** `:id`-style segments can carry characters a URL may not hold raw (a custom provider id has `:`). */
const segment = (value: string): string => encodeURIComponent(value);

/** Sends `body` as JSON when there is one; `undefined` stays a bodyless request (`/pin` toggles). */
async function send<T>(path: string, init: RequestInit, body?: unknown): Promise<T> {
  const options: RequestInit = body === undefined
    ? init
    : {
      ...init,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    };
  const response = await request(path, options);
  if (!response.ok) throw await apiErrorOf(response);
  return response.json() as Promise<T>;
}

const get = <T>(path: string): Promise<T> => send<T>(path, {});
const post = <T>(path: string, body?: unknown): Promise<T> => send<T>(path, { method: 'POST' }, body);
const put = <T>(path: string, body: unknown): Promise<T> => send<T>(path, { method: 'PUT' }, body);
const del = <T>(path: string): Promise<T> => send<T>(path, { method: 'DELETE' });

const abortLike = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

const textOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A line is forwarded only when it is an envelope: a malformed line, a non-object or the removed
 * `[DONE]` sentinel must not reach the reducer and must not look like a transport failure.
 */
function parseEnvelope(data: string): StreamEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const frame = parsed as Partial<StreamEnvelope>;
  if (typeof frame.type !== 'string') return undefined;
  if (typeof frame.id !== 'string' || typeof frame.ts !== 'number') return undefined;
  if (typeof frame.payload !== 'object' || frame.payload === null) return undefined;
  return frame as StreamEnvelope;
}

function turnIdOf(frame: StreamEnvelope): string | undefined {
  const turnId = (frame.payload as { turnId?: unknown }).turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

/**
 * The one SSE read loop, shared by `/chat/stream` and `/chat/regenerate` (both answer
 * `200 + text/event-stream`).
 *
 * Settlement rules (Task 19B rulings):
 * - resolve when the stream ends — a normal end, a 202, a clean close and a caller abort alike;
 * - reject only on a real failure: a non-2xx status, a 200 that is not an event stream, or a reader
 *   throw, each as an `ApiError` carrying a `code`;
 * - `onEvent` never fires after the promise settles, and the terminal frame fires at most once.
 *
 * There is no `[DONE]` sentinel any more, so the end of the response IS the end of the stream, and
 * `: ping` comments never reach the parser. The harness listens on `res.on('close')`, so an abort
 * cancels the turn server-side: the transport mirrors that with a synthetic `turn/end` (`'cancelled'`
 * for an abort, `'error'` for a close that never carried one) so `settled`/`toolProgress` cannot leave
 * a phantom running turn. That frame's `id`/`seq`/`ts` are bookkeeping only — the reducer's `turn/end`
 * branch reads `payload.reason` and nothing else, and no durable row stands behind it.
 */
async function readStream(
  path: string,
  body: unknown,
  onEvent: StreamHandler,
  signal?: AbortSignal,
): Promise<void> {
  const response = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).catch((error: unknown) => {
    // Aborted before the first byte: nothing started, so there is no turn to settle and no error.
    if (abortLike(error)) return undefined;
    throw new ApiError(0, TRANSPORT_ERROR_CODE, textOf(error));
  });
  if (response === undefined) return;

  // Status first, content type second — never body sniffing. A 202 means the message was steered
  // into the turn that is already running: a synthetic frame, not an error.
  if (response.status === 202) {
    const queued = (await response.json().catch(() => undefined)) as ChatQueuedResponse | undefined;
    // Fall back to the body we just sent so older servers still render the queued text.
    const sentMessage = typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message?: unknown }).message
      : undefined;
    const frame: QueuedFrame = {
      type: 'transport/queued',
      payload: {
        ...(queued?.position === undefined ? {} : { position: queued.position }),
        ...(queued?.message !== undefined
          ? { message: queued.message }
          : typeof sentMessage === 'string' ? { message: sentMessage } : {}),
      },
    };
    onEvent(frame);
    return;
  }
  if (!response.ok) throw await apiErrorOf(response);

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new ApiError(response.status, UNEXPECTED_RESPONSE_CODE, 'expected an event-stream response');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lastTurnId = '';
  let lastSeq = 0;
  /** The loop's own `turn/end` has been delivered, so no synthetic one may follow it. */
  let turnEndSeen = false;
  /** The promise has settled (or is about to); `onEvent` is silent from here on. */
  let finished = false;

  // Live deltas are batch-flushed on a display cadence (deepseek-harness style):
  // state folds at token rate, the VIEW publishes at frame rate. Without it, a
  // single network read carrying 50 delta frames dispatches 50 state updates
  // inside one task, React renders once, and text appears in blocks instead of
  // typing. Three chained rAFs (~50ms at 60Hz) collapse a burst into one
  // commit; a durable frame (or terminal path) cancels the wait and flushes
  // immediately, preserving frame order.
  const DELTA_FRAMES = 3;
  let pendingDeltas: ChatAction[] = [];
  let frameChain: number | null = null;

  const flushDeltas = (): void => {
    frameChain = null;
    if (pendingDeltas.length === 0) return;
    const batch = pendingDeltas;
    pendingDeltas = [];
    for (const frame of batch) {
      if (finished) return;
      emitFrame(frame);
    }
  };

  const scheduleDeltaFlush = (): void => {
    if (frameChain !== null) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame.bind(window)
      : undefined;
    if (raf === undefined) {
      // No rAF (background tab / non-browser): fall back to a timer.
      frameChain = setTimeout(flushDeltas, 50) as unknown as number;
      return;
    }
    let depth = 0;
    const step = (): void => {
      depth += 1;
      if (depth < DELTA_FRAMES) {
        frameChain = raf(step);
        return;
      }
      frameChain = null;
      flushDeltas();
    };
    frameChain = raf(step);
  };

  const isDelta = (frame: ChatAction): boolean =>
    frame.type === 'assistant/delta' || frame.type === 'thought/delta';

  /** Order-only bookkeeping for every frame that leaves the transport. */
  const track = (frame: ChatAction): void => {
    if (frame.type !== 'transport/queued' && frame.type !== 'transport/queued-clear') {
      if (typeof frame.seq === 'number') lastSeq = frame.seq;
      const turnId = turnIdOf(frame);
      if (turnId !== undefined) lastTurnId = turnId;
    }
    if (frame.type === 'turn/end') turnEndSeen = true;
  };

  const emitFrame = (frame: ChatAction): void => {
    track(frame);
    onEvent(frame);
  };

  const deliver = (frame: ChatAction): void => {
    if (finished) return;
    // Frames may still land after `turn/end` (the auto-title write in `routes/chat.ts` is deliberately
    // non-blocking), and the reducer handles them, so they are forwarded rather than dropped.
    if (isDelta(frame)) {
      pendingDeltas.push(frame);
      scheduleDeltaFlush();
      return;
    }
    flushDeltas();
    emitFrame(frame);
  };

  const endTurn = (reason: 'cancelled' | 'error'): void => {
    // Pending deltas belong before any synthetic terminal frame.
    flushDeltas();
    if (turnEndSeen || finished) return;
    turnEndSeen = true;
    onEvent({
      id: 'evt_transport_end',
      seq: lastSeq,
      type: 'turn/end',
      payload: { turnId: lastTurnId, reason },
      ts: Date.now(),
    });
  };

  const feed = createSSEParser((data) => {
    const frame = parseEnvelope(data);
    if (frame !== undefined) deliver(frame);
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    // The stream ended without a sentinel: flush the decoder and any unterminated trailing line.
    feed(decoder.decode(), true);
    // No `turn/end` reached us, so the response was cut short and the turn did not complete.
    endTurn('error');
  } catch (error) {
    if (abortLike(error)) {
      // The server saw the socket close and aborted the turn: report stopped, not failed.
      endTurn('cancelled');
      return;
    }
    endTurn('error');
    throw new ApiError(0, TRANSPORT_ERROR_CODE, textOf(error));
  } finally {
    finished = true;
    if (frameChain !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameChain);
      clearTimeout(frameChain as unknown as ReturnType<typeof setTimeout>);
      frameChain = null;
    }
  }
}

/**
 * The harness transport: one namespace per route group, mirroring `server/src/routes/*` field for
 * field. Task 19C rewires the components onto this object.
 */
export const api = {
  /** `/api/projects`. */
  projects: {
    list: (): Promise<Project[]> => get<Project[]>('/projects'),
    create: (input: { name: string; description?: string }): Promise<Project> =>
      post<Project>('/projects', input),
    /** Same `{ ok, id }` body as a session delete (`routes/projects.ts`). */
    delete: (id: string): Promise<SessionDeleteResult> =>
      del<SessionDeleteResult>(`/projects/${segment(id)}`),
  },

  /** `/api/sessions` — summaries on the rail, the whole projection only when a session opens. */
  sessions: {
    list: (projectId?: string): Promise<SessionSummary[]> =>
      get<SessionSummary[]>(withQuery('/sessions', { projectId })),
    create: (input: { projectId: string; title?: string; model?: string }): Promise<SessionDetail> =>
      post<SessionDetail>('/sessions', input),
    get: (id: string): Promise<SessionDetail> => get<SessionDetail>(`/sessions/${segment(id)}`),
    /** No `pinned` body means "flip whatever is stored" (`sessions.ts`: `pinned ?? !current.isPinned`). */
    pin: (id: string, pinned?: boolean): Promise<SessionPinResult> =>
      post<SessionPinResult>(`/sessions/${segment(id)}/pin`, pinned === undefined ? undefined : { pinned }),
    delete: (id: string): Promise<SessionDeleteResult> =>
      del<SessionDeleteResult>(`/sessions/${segment(id)}`),
    /** Reverts to just before a user message, the user message, and the assistant/tool turns after it. */
    undoMessage: (id: string, messageId: string): Promise<SessionDetail> =>
      post<SessionDetail>(`/sessions/${segment(id)}/undo-message`, { messageId }),
    /** Copies the effective log prefix into a new visible checkout session (redo/branch). */
    branch: (id: string, toSeq?: number): Promise<SessionDetail> =>
      post<SessionDetail>(`/sessions/${segment(id)}/branch`, toSeq === undefined ? {} : { toSeq }),
    /**
     * Git-like history (Phase 4): the Studio checkpoints recorded for this session, newest first.
     * Each row says whether its change can be undone and why not, so the UI never offers a dead
     * restore button.
     */
    checkpoints: (id: string): Promise<WorkspaceCheckpoint[]> =>
      get<WorkspaceCheckpoint[]>(`/sessions/${segment(id)}/checkpoints`),
    /** Read-only preview: re-reads the live place to report drift before anything is written. */
    previewRestore: (id: string, checkpointId: string): Promise<RestorePreview> =>
      get<RestorePreview>(`/sessions/${segment(id)}/checkpoints/${segment(checkpointId)}/restore`),
    /** Applies the inverse plan; the server answers `restore-failed` rather than lying. */
    restore: (id: string, checkpointId: string): Promise<RestoreResult> =>
      post<RestoreResult>(`/sessions/${segment(id)}/checkpoints/${segment(checkpointId)}/restore`, {}),
    /**
     * Turn-level undo: restores every restorable checkpoint of one turn. Drift on any target
     * refuses the whole turn (`status: 'refused'`) rather than leaving it half old, half new.
     */
    undoTurn: (id: string, callIds: string[]): Promise<TurnRestoreResult> =>
      post<TurnRestoreResult>(`/sessions/${segment(id)}/undo-turn`, { callIds }),
    /** The goal is a durable event, not a session column: the loop reads it back off the log. */
    setGoal: (id: string, objective: string): Promise<GoalSetResult> =>
      post<GoalSetResult>(`/sessions/${segment(id)}/goal`, { objective }),
    clearGoal: (id: string): Promise<GoalClearResult> =>
      del<GoalClearResult>(`/sessions/${segment(id)}/goal`),
    /** Plan mode is likewise a durable `plan/mode` event; the prompt folds it the same way. */
    setPlanMode: (id: string, active: boolean): Promise<PlanSetResult> =>
      post<PlanSetResult>(`/sessions/${segment(id)}/plan`, { active }),
    clearPlanMode: (id: string): Promise<PlanClearResult> =>
      del<PlanClearResult>(`/sessions/${segment(id)}/plan`),
    /** Starts a detached child and returns immediately; `subagent/end` settles later. */
    runSubagent: (id: string, task: string): Promise<SubagentRunResult> =>
      post<SubagentRunResult>(`/sessions/${segment(id)}/subagent`, { task }),
    subagentTree: (id: string): Promise<SubagentTreeEntry[]> =>
      get<SubagentTreeEntry[]>(`/sessions/${segment(id)}/subagent/list`),
    interruptSubagent: (id: string, childId: string): Promise<SubagentInterruptResult> =>
      post<SubagentInterruptResult>(`/sessions/${segment(id)}/subagent/${segment(childId)}/interrupt`),
  },

  /** `/api/chat` — the only place a turn starts. */
  chat: {
    /**
     * `200 + text/event-stream` streams envelopes; `202 { queued }` dispatches one synthetic
     * `transport/queued` frame; anything else rejects with an `ApiError`.
     */
    stream: (params: ChatStreamBody, onEvent: StreamHandler, signal?: AbortSignal): Promise<void> =>
      readStream('/chat/stream', params, onEvent, signal),
    cancel: (sessionId: string): Promise<ChatCancelResult> =>
      post<ChatCancelResult>('/chat/cancel', { sessionId }),
    /** Drops every steering message still waiting in the inbox; already-drained steers stay durable. */
    clearQueue: (sessionId: string): Promise<ChatQueueClearResult> =>
      post<ChatQueueClearResult>('/chat/queue/clear', { sessionId }),
    /** Same envelope contract as `stream`; a busy session answers `409 SESSION_BUSY`. */
    regenerate: (params: ChatRegenerateBody, onEvent: StreamHandler, signal?: AbortSignal): Promise<void> =>
      readStream('/chat/regenerate', params, onEvent, signal),
  },

  /** `/api/approvals` — settles the request the stream announced; the body is exactly `{decision,scope}`. */
  approvals: {
    decide: (approvalId: string, body: ApprovalDecisionBody): Promise<ApprovalDecisionResult> =>
      post<ApprovalDecisionResult>(`/approvals/${segment(approvalId)}`, body),
  },

  /** `/api/providers` — an `apiKey` never travels over HTTP (`safeStorage` owns it). */
  providers: {
    list: (): Promise<ProviderStatus[]> => get<ProviderStatus[]>('/providers'),
    updateConfig: (id: string, config: ProviderConfigBody): Promise<ProviderStatus> =>
      put<ProviderStatus>(`/providers/${segment(id)}/config`, config),
    /** Bridge liveness for a keyless provider (DeepSeek web bridge on 127.0.0.1:8000). */
    bridgeStatus: (id: string): Promise<ProviderBridgeStatus> =>
      get<ProviderBridgeStatus>(`/providers/${segment(id)}/bridge`),
    /** Ask the bridge to initialise its session — this is the "connect account" action. */
    connect: (id: string): Promise<ProviderConnectResult> =>
      post<ProviderConnectResult>(`/providers/${segment(id)}/connect`),
  },

  /** `/api/models` — usable-only; there is no `refresh` flag and no `/models/providers` route. */
  models: {
    list: (): Promise<ModelInfo[]> => get<ModelInfo[]>('/models'),
  },

  /** `/api/skills` — catalogue metadata only; the skill body is injected server-side, never served. */
  skills: {
    list: (sessionId?: string): Promise<SkillMeta[]> =>
      get<SkillMeta[]>(withQuery('/skills', { sessionId })),
  },

  /** `/api/tools` + `/api/sessions/:sessionId/tools/:name` (the tools router mounts at `/api`). */
  tools: {
    list: (sessionId?: string): Promise<ToolMetadata[]> =>
      get<ToolMetadata[]>(withQuery('/tools', { sessionId })),
    toggle: (sessionId: string, name: string, enabled: boolean): Promise<ToolToggleResult> =>
      post<ToolToggleResult>(`/sessions/${segment(sessionId)}/tools/${segment(name)}`, { enabled }),
  },

  /**
   * `/api/mcp` — ba route, cả ba đều trả về `McpStatus` mới nên panel không phải refetch sau khi ghi.
   * `setPath` là ô ghi đè đường dẫn của MCP tab (Task 24): `null` nghĩa là "bỏ ghi đè, tự phát hiện",
   * còn một chuỗi ngoài allowlist §4.11 bị server từ chối `MCP_PATH_REJECTED` (400) và KHÔNG ghi gì cả
   * (`server/src/routes/mcp.ts:23-34`), vì vậy caller phải giữ nguyên giá trị cũ khi nhận lỗi.
   */
  mcp: {
    status: (): Promise<McpStatus> => get<McpStatus>('/mcp/status'),
    reconnect: (): Promise<McpStatus> => post<McpStatus>('/mcp/reconnect'),
    setPath: (path: string | null): Promise<McpStatus> => put<McpStatus>('/mcp/path', { path }),
  },

  /** `/api/memory`. */
  memory: {
    stats: (): Promise<MemoryStats> => get<MemoryStats>('/memory/stats'),
    clear: (): Promise<MemoryClearResult> => del<MemoryClearResult>('/memory'),
  },

  /** `/api/search` — ranked content hits for the palette (empty query answers an empty page). */
  search: {
    query: (q: string, options?: { limit?: number; offset?: number; sessionId?: string }): Promise<SearchPage> =>
      get<SearchPage>(withQuery('/search', {
        q,
        limit: options?.limit === undefined ? undefined : String(options.limit),
        offset: options?.offset === undefined ? undefined : String(options.offset),
        sessionId: options?.sessionId,
      })),
  },
};
