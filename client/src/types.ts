/**
 * Client mirror of the server harness types. Everything in the "wire" blocks must stay field-for-field
 * with the server file named in its comment: the SSE envelope, the session projections and the route
 * payloads (including the small tool/memory/pin/cancel bodies) are the contract, and the client has no
 * other source of truth. Types that are NOT on the wire live in `lib/chatReducer.ts` — see the
 * `ApprovalRequest` note in the approvals block.
 */

// ---------------------------------------------------------------------------
// Shared primitives — server/src/harness/shared/types.ts
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'waiting_approval' | 'cancelled';

// ---------------------------------------------------------------------------
// Durable events — server/src/harness/events/types.ts (EventPayloadMap)
// ---------------------------------------------------------------------------

export type TurnTrigger = 'user' | 'steer' | 'goal' | 'workflow' | 'regenerate';
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled';

export interface EventPayloadMap {
  'session/created': { projectId: string; title: string; modelSelection?: string };
  'session/title': { title: string; source: 'auto' | 'user' };
  'session/revert': { toSeq: number };
  'session/skills': { skills: string[] };
  'turn/start': { turnId: string; modelSelection: string; trigger: TurnTrigger; regeneratedFrom?: { userMessageId: string; supersedesAssistantMessageId: string } };
  'step/start': { stepId: string; index: number };
  'user/message': { messageId: string; content: string; source: 'user' | 'steer' | 'notice'; attachments?: Array<{ id: string; name: string; mime: string; size: number }> };
  'assistant/message': { messageId: string; content: string; reasoning?: string; finishReason: FinishReason; usage?: TokenUsage; callIds: string[]; activity?: AssistantActivity[] };
  'assistant/attempt': { attemptId: string; error: string; retryable: boolean; finishedAt: number };
  'tool/call': { callId: string; name: string; args: unknown; startedAt: number; label?: string; risk?: 'low' | 'medium' | 'high' };
  'tool/result': { callId: string; status: 'done' | 'error' | 'cancelled'; result?: unknown; durationMs: number };
  'approval/request': { approvalId: string; callId: string; name: string; args: unknown; risk: 'low' | 'medium' | 'high' };
  'approval/decision': { approvalId: string; decision: 'allow' | 'deny' | 'expired'; scope: 'once' | 'session' };
  'compaction/summary': { summary: string; coveredFrom: number; coveredTo: number; tokenEstimate: number };
  'turn/end': { turnId: string; reason: 'completed' | 'cancelled' | 'max_steps' | 'error'; error?: { code: string; message: string; retryable: boolean } };
  'goal/changed': { goalId: string; status: 'active' | 'done' | 'blocked'; objective: string };
  'plan/mode': { active: boolean; plan?: string; updatedAt: number };
  'deliverables/presented': { files: Array<{ path: string; description?: string }>; turnId?: string };
  'job/started': { jobId: string; kind: string; label: string };
  'job/completed': { jobId: string; kind: string; label: string; status: 'completed' | 'killed' | 'failed'; detail?: string };
  'attachment/added': { attachmentId: string; messageId: string; name: string; mime: string; size: number };
  'todo/write': { todos: Array<{ title: string; status: 'todo' | 'doing' | 'done' }> };
  'subagent/start': { subagentId: string; parentSessionId: string; childSessionId: string; task: string };
  'subagent/end': { subagentId: string; status: 'done' | 'error' | 'cancelled'; summary: string; toolCount?: number; failedToolCount?: number; durationMs?: number };
  'workflow/start': { workflowId: string; name: string; phases: string[] };
  'workflow/phase': { workflowId: string; phase: string; status: 'started' | 'completed' | 'failed' };
  'workflow/end': { workflowId: string; status: 'completed' | 'failed' | 'cancelled' };
}

export type EventType = keyof EventPayloadMap;

// ---------------------------------------------------------------------------
// Live events — server/src/harness/shared/types.ts (LiveEvent)
// ---------------------------------------------------------------------------

export interface LiveEventPayloadMap {
  'assistant/delta': { turnId: string; text: string };
  'thought/delta': { turnId: string; text: string };
  'tool/progress': { callId: string; message: string };
  'agent/status': { state: AgentStatus; turnId?: string };
  'mcp/status': { connected: boolean; studioLinked: boolean };
  error: { code: string; message: string; retryable: boolean };
}

export type LiveEventType = keyof LiveEventPayloadMap;

// ---------------------------------------------------------------------------
// SSE envelope — server/src/http/sse.ts (writeSSE)
// Durable frames carry the persisted `seq` and id `evt_<rowId>`; live frames carry a generated
// `evt_` id and no `seq`.
// ---------------------------------------------------------------------------

export type DurableEnvelope = {
  [T in EventType]: { id: string; seq: number; type: T; payload: EventPayloadMap[T]; ts: number };
}[EventType];

export type LiveEnvelope = {
  [T in LiveEventType]: { id: string; seq?: undefined; type: T; payload: LiveEventPayloadMap[T]; ts: number };
}[LiveEventType];

export type StreamEnvelope = DurableEnvelope | LiveEnvelope;

// ---------------------------------------------------------------------------
// Projections — server/src/harness/session/projections.ts
// ---------------------------------------------------------------------------

export interface DerivedToolCall {
  callId: string;
  name: string;
  args: unknown;
  /** Vietnamese label measured by the server (policy table); absent on rows written before 31C. */
  label?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  result?: unknown;
  durationMs?: number;
}

export interface DerivedApproval {
  approvalId: string;
  callId: string;
  name: string;
  args: unknown;
  risk: 'low' | 'medium' | 'high';
  decision?: 'allow' | 'deny' | 'expired';
}

export type DerivedStep =
  | { type: 'text'; content: string }
  | { type: 'call'; call: DerivedToolCall }
  | { type: 'approval'; approval: DerivedApproval }
  | {
      type: 'subagent';
      subagentId: string;
      task: string;
      childSessionId: string;
      status: 'running' | 'done' | 'error' | 'cancelled';
      summary: string | null;
      toolCount: number;
      failedToolCount: number;
      durationMs: number;
    };

/** One ordered piece of a turn: thinking, spoken text, or a tool call. */
export type TurnTimelineEntry =
  | { type: 'thinking'; text: string; key: string }
  | { type: 'text'; text: string; key: string }
  /** `denied` carries the user's refusal: the call fails by decision, not by its own error. */
  | { type: 'call'; step: Extract<DerivedStep, { type: 'call' }>; key: string; denied?: boolean };

/** One piece in the order the provider streamed it (server event sequence); `call` resolves by id. */
export type AssistantActivity =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'call'; callId: string };

export interface DerivedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  steps: DerivedStep[];
  activity?: AssistantActivity[];
  usage?: TokenUsage;
  createdAt: number;
  superseded: boolean;
  attachments?: Array<{ id: string; name: string; mime: string; size: number }>;
  /** Provenance of a user row; `notice` is runtime delivery (background completion), not the user. */
  source?: 'user' | 'steer' | 'notice';
  /**
   * Client-only: id of the live draft frame that opened this step. ChatView keys the durable row
   * with it so `assistant/message` reuses the draft row's DOM instead of remounting it, letting
   * in-flight word animations finish when the stream settles.
   */
  handoffKey?: string;
}

// ---------------------------------------------------------------------------
// Sessions — server/src/harness/session/store.ts
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  createdAt: number;
  lastUpdated: number;
  isPinned: boolean;
  status: string;
  modelSelection?: string;
  goalId?: string;
  isSubagent?: boolean;
  parentSessionId?: string;
}

export interface SessionDetail extends SessionSummary {
  messages: DerivedMessage[];
  steps: DerivedStep[];
  skills: string[];
  /** Objective of the active goal, read off the session's `goal/changed` events. */
  goal?: string;
  /** Whether plan mode is active, read off its `plan/mode` events. */
  planActive?: boolean;
  /** The durable todo list (last `todo/write` wins), for the composer panel. */
  todos?: Array<{ title: string; status: 'todo' | 'doing' | 'done' }>;
  /** Latest durable provider failure, so reopening a session keeps its error card. */
  error?: { code: string; message: string; retryable: boolean };
}

// ---------------------------------------------------------------------------
// Approvals — server/src/harness/tools/approval.ts, server/src/routes/approvals.ts
// ---------------------------------------------------------------------------

export type ApprovalRisk = 'low' | 'medium' | 'high';export type ApprovalDecision = 'allow' | 'deny' | 'expired';
export type ApprovalScope = 'once' | 'session';

/**
 * The pending request the stream announced with `approval/request`; `POST /api/approvals/:id` settles it.
 * Field-for-field with `server/src/harness/events/types.ts` `approval/request` — the wire carries no
 * `turnId`; the reducer adds one to its own `PendingApproval` (lib/chatReducer.ts) for UI convenience.
 */
export interface ApprovalRequest {
  approvalId: string;
  callId: string;
  name: string;
  args: unknown;
  risk: ApprovalRisk;
}

export interface ApprovalDecisionBody {
  decision: 'allow' | 'deny';
  scope: ApprovalScope;
}

export interface ApprovalDecisionResult {
  ok: boolean;
  approvalId: string;
  decision: 'allow' | 'deny';
  scope: ApprovalScope;
}

// ---------------------------------------------------------------------------
// Providers / models / MCP — server/src/routes/providers.ts, models.ts, mcp.ts
// `ProviderStatus` mirrors the ROUTE row (`providerRow`), not the internal providerStatus() object.
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  providerId: string;
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  custom: boolean;
  /** Provider authenticates without a credential (the local DeepSeek bridge); no key row is shown. */
  keyless?: boolean;
}

export interface ProviderConfigBody {
  baseUrl?: string;
  enabled?: boolean;
}

/**
 * `GET /api/providers/:id/bridge` — liveness of the local bridge behind a keyless provider
 * (`services/deepseekChatBridge.ts`). Says nothing about the account: reachability only.
 */
export interface ProviderBridgeStatus {
  state: 'unknown' | 'reachable' | 'unreachable';
  baseUrl: string;
  detail?: string;
}

/**
 * `POST /api/providers/:id/connect` — the outcome of asking the bridge to initialise its session.
 * `waiting` is the honest middle state: a login window is open right now and the user has not
 * finished signing in yet, so the card says "check again" rather than "failed".
 */
export interface ProviderConnectResult {
  state: 'connected' | 'login_required' | 'waiting' | 'unreachable';
  baseUrl: string;
  message: string;
}

/** GET /api/models -> `LlmRegistry.getModels()` (server/src/harness/llm/types.ts `ModelInfo`). */
/** How hard a model should think; only models that declare `efforts` accept one. Mirrors
 *  the levels catalogues declare (`reasoning.supported_efforts`). */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * How tool calls are approved for a turn. Sent to `POST /chat/stream`; the server's approval gate
 * resolves each tool's own `approval` field against it. Mirrors `PermissionMode` in
 * server/src/harness/shared/types.ts.
 */
export type PermissionMode = 'ask' | 'balanced' | 'full';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  context?: number;
  /** Levels this model accepts. Absent means it has no reasoning knob, not "unknown". */
  efforts?: ReasoningEffort[];
  supportsTools: boolean;
  /** Image input support from the catalogue. Absent means unknown (permissive, not "no"). */
  supportsImages?: boolean;
}

/** GET /api/skills -> `createSkillsRouter` metadata (`server/src/routes/skills.ts`). Skill bodies are
 *  injected server-side and never served to the UI, so the slash palette only ever sees this shape. */
export interface SkillMeta {
  name: string;
  description: string;
  triggers: string[];
  source: string;
  active: boolean;
}

/**
 * Beyond the block's headline list (providers/models/MCP): the tool and memory route bodies, mirrored
 * deliberately because Task 19B types `api.tools.*` and `api.memory.*` against them.
 */
/** POST /api/sessions/:id/goal — one active goal per session; the loop reads it back off the log. */
export interface GoalSetResult {
  id: string;
  goalId: string;
  status: 'active';
  objective: string;
}

/** DELETE /api/sessions/:id/goal — the goal ends (status `done`), the prompt stops seeing it. */
export interface GoalClearResult {
  ok: true;
  id: string;
}

/** POST /api/sessions/:id/plan — plan/mode whole-value-replace; the loop reads it back off the log. */
export interface PlanSetResult {
  id: string;
  active: boolean;
}

/** DELETE /api/sessions/:id/plan — plan mode ends, the prompt stops seeing the plan section. */
export interface PlanClearResult {
  ok: true;
  id: string;
}

/** POST /api/sessions/:id/subagent — starts a child session and returns immediately. */
export interface SubagentRunResult {
  id: string;
  subagentId: string;
  childSessionId: string;
  status: 'running';
}

export interface SubagentTreeEntry {
  subagentId: string;
  childSessionId: string;
  task: string;
  status: 'running' | 'inactive';
  memberName?: string;
  durationMs?: number;
  toolCount?: number;
}

export interface SubagentInterruptResult {
  id: string;
  childId: string;
  accepted: boolean;
  interrupted: boolean;
}

/** GET /api/search — ranked FTS hits with snippets (server/src/routes/search.ts). */
export interface SearchHit {
  sessionId: string;
  seq: number;
  type: string;
  snippet: string;
  sessionTitle: string;
}

export interface SearchPage {
  hits: SearchHit[];
  total: number;
}

/** GET /api/tools -> `toMetadata()` (server/src/routes/tools.ts); the schema/execute never leave the server. */
export interface ToolMetadata {
  name: string;
  description: string;
  label: string;
  risk: ApprovalRisk;
  approval: 'auto' | 'ask' | 'ask-once';
  concurrencySafe: boolean;
  enabled: boolean;
}

/** GET /api/memory/stats (server/src/harness/harness.ts `MemoryStats`). */
export interface MemoryStats {
  projects: number;
  sessions: number;
  events: number;
  approxBytes: number;
  legacyBackup?: string;
}

/** DELETE /api/memory — the counts wiped, so the panel can confirm what it removed. */
export interface MemoryClearResult {
  ok: boolean;
  cleared: { projects: number; sessions: number; events: number };
}

export interface McpServerInfo {
  source: 'settings' | 'studio-builtin' | 'studio-binary' | 'none';
  path: string | null;
  version: string | null;
}

/** GET /api/mcp/status; the live `mcp/status` event keeps the smaller {connected, studioLinked}. */
export interface McpStatus {
  connected: boolean;
  studioLinked: boolean;
  server: McpServerInfo;
  /** The place `list_roblox_studios` resolved, or null when none is open (Task 31C). */
  studio: { id: string; name: string | null } | null;
  /** Tools published under `studio.*` by the last `tools/list`. */
  toolCount: number;
  /** Last failure in the `vi.errors` vocabulary; cleared by the next successful call. */
  lastError: { code: string; message: string } | null;
  logs: string[];
}

// ---------------------------------------------------------------------------
// Error envelope — unified server-side (server/src/http/validation.ts)
// ---------------------------------------------------------------------------

/** Every code a route can answer with — read off the `new HttpError(...)` sites, not guessed. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR' // http/validation.ts:53,89 + every zod body/query/path
  | 'API_KEY_NOT_ACCEPTED' // http/validation.ts:46
  | 'SESSION_BUSY' // routes/chat.ts:185
  | 'MESSAGE_NOT_FOUND' // routes/chat.ts:190
  | 'APPROVAL_NOT_FOUND' // routes/approvals.ts:23
  | 'SESSION_NOT_FOUND' // routes/chat.ts:130, sessions.ts:20, tools.ts:42
  | 'PROJECT_NOT_FOUND' // routes/sessions.ts:42, projects.ts:32
  | 'TOOL_NOT_FOUND' // routes/tools.ts:44
  | 'NO_PROVIDER' // routes/chat.ts:36
  | 'UNKNOWN_PROVIDER' // routes/providers.ts:55
  | 'MCP_PATH_REJECTED' // routes/mcp.ts:27
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

/**
 * Live `error` frame codes the loop owns. Provider failures ride the same frame with their own code
 * (`http_error`, `stream_error`, ... from `harness/llm/*`), so consumers switch on the string, never
 * exhaustively on this union — `ChatError.code` stays a `string` for exactly that reason.
 */
export type StreamErrorCode =
  | 'TURN_TIMEOUT' // agent/loop.ts:225
  | 'CONTEXT_TRIMMED' // agent/loop.ts:281
  | 'CONTEXT_OVERFLOW'
  | 'TOO_MANY_TOOL_CALLS' // agent/loop.ts:315
  | 'AGENT_ERROR' // agent/loop.ts:112, routes/chat.ts:110
  | 'SESSION_BUSY';

// `| (string & {})` keeps the literals as autocomplete suggestions while still admitting a code the
// server added since — a bare `| string` collapses the union and loses both.
export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode | (string & {});
    message?: string;
    details?: unknown;
  };
}

/** POST /api/chat/stream on a busy session: 202, no stream — the message is steered at the next boundary. */
export interface ChatQueuedResponse {
  queued: true;
  /** Inbox depth after this message landed (1-based). */
  position?: number;
  /** The exact text that was queued, so the queue card can display it. */
  message?: string;
}

/** POST /api/chat/queue/clear — how many still-waiting steers were dropped. */
export interface ChatQueueClearResult {
  sessionId: string;
  cleared: number;
}

/** A file or image staged in the composer and sent along with the text of a turn. */
export interface ChatAttachment {
  /** Original file name, kept for display and downstream tooling. */
  name: string;
  /** MIME type, e.g. `image/png` or `application/pdf`. */
  mime: string;
  /** Byte size of the original file. */
  size: number;
  /** Raw base64 payload (no `data:` prefix) of the file contents. */
  data: string;
}

export interface ChatStreamBody {
  sessionId: string;
  message: string;
  model?: string;
  /** Omitted when the user did not pick a level; the server then sends no reasoning knob. */
  effort?: ReasoningEffort;
  /** Omitted when the user did not pick a mode; the server then uses its default (`balanced`). */
  permissionMode?: PermissionMode;
  /** User's preferred reply language (Settings); omitted means follow the message. */
  language?: 'vi' | 'en';
  /** Files/images attached in the composer; absent when none were staged. */
  attachments?: ChatAttachment[];
}

export interface ChatRegenerateBody {
  sessionId: string;
  assistantMessageId: string;
  /** User's preferred reply language (Settings); omitted means follow the message. */
  language?: 'vi' | 'en';
}

export interface ChatCancelBody {
  sessionId: string;
}

/** POST /api/chat/cancel (server/src/routes/chat.ts:177) — `false` when the turn had already finished. */
export interface ChatCancelResult {
  sessionId: string;
  cancelled: boolean;
}

/** POST /api/sessions/:id/pin (server/src/routes/sessions.ts:74) — the flag after the toggle. */
export interface SessionPinResult {
  id: string;
  isPinned: boolean;
}

/** DELETE /api/sessions/:id (server/src/routes/sessions.ts:86). */
export interface SessionDeleteResult {
  ok: true;
  id: string;
}

/** POST /api/sessions/:sessionId/tools/:name (server/src/routes/tools.ts:46). */
export interface ToolToggleResult {
  sessionId: string;
  name: string;
  enabled: boolean;
}

// ===========================================================================
// Các shape còn lại KHÔNG thuộc khối legacy ở trên: project vẫn giữ nguyên như server
// (`ProjectRecord`). Các shape legacy (`Session`/`Message`/`MessageStep`/`Model`/`StreamChunk`)
// đã được Task 19C xoá cùng lúc với `legacyApi` — không còn thành phần nào tham chiếu.
// ===========================================================================

/** Projects are unchanged server-side (`ProjectRecord` in server/src/harness/session/store.ts); kept as-is. */
export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  lastActive: number;
}

// ---------------------------------------------------------------------------
// Git-like history — server/src/harness/checkpoints/{store,snapshot,restore}.ts
// ---------------------------------------------------------------------------

/** One script whose source the snapshot holds, or one inserted instance. */
export type CheckpointSnapshotEntry =
  | { kind: 'script'; path: string; source: string }
  | { kind: 'properties'; path: string; properties: Record<string, unknown> }
  | { kind: 'inserted'; path: string };

export type CheckpointInverseStep =
  | { tool: 'script_write'; path: string; source: string }
  | { tool: 'set_properties'; path: string; properties: Record<string, unknown> }
  | { tool: 'delete_instance'; path: string };

export interface CheckpointPreState {
  entries: CheckpointSnapshotEntry[];
  inverse: CheckpointInverseStep[];
  notes: string[];
}

export interface CheckpointManifest {
  tool: string;
  callId: string;
  argsHash: string;
  targets: string[];
  outcome: 'ok' | 'error' | 'cancelled' | 'denied';
  /** `null` when no pre-state could be read — the checkpoint is then audit-only. */
  preState: CheckpointPreState | null;
  restorable: boolean;
  /** Shown verbatim; names the real limitation when `restorable` is false. */
  restoreReason: string;
}

export type CheckpointStatus = 'recorded' | 'restoring' | 'restored' | 'restore-failed';

export interface WorkspaceCheckpoint {
  id: string;
  sessionId: string;
  createdAt: number;
  label: string | null;
  baseEventSeq: number | null;
  rootHash: string;
  manifest: CheckpointManifest;
  status: CheckpointStatus;
}

export interface RestoreStepPlan {
  path: string;
  action: 'restore-script' | 'restore-properties' | 'delete-inserted';
  summary: string;
}

export interface RestorePreview {
  checkpointId: string;
  clean: boolean;
  steps: RestoreStepPlan[];
  drift: string[];
  notes: string[];
}

export interface RestoreResult {
  checkpointId: string;
  status: 'restored' | 'restore-failed';
  applied: number;
  failed: Array<{ path: string; reason: string }>;
  /** Properties this Studio build refused, in its own words. Not a failure. */
  skipped?: RestoreSkipped[];
}

export interface RestoreSkipped {
  path: string;
  key: string;
  reason: string;
}

/** Turn-level undo result — server/src/harness/checkpoints/restore.ts `restoreTurn`. */
export interface TurnRestoreResult {
  restored: string[];
  failed: Array<{ path: string; reason: string }>;
  /** Properties this Studio build refused, in its own words. */
  skipped?: RestoreSkipped[];
  notRestorable: Array<{ checkpointId: string; reason: string }>;
  drift: string[];
  status: 'restored' | 'restore-failed' | 'refused';
}
