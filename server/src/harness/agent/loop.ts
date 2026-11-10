import { effectiveWindow, fitToolsToWindow, toolOutputBudgetChars } from '../shared/window';
import type { CompactionService } from '../compaction/service';
import { estimateTokens } from '../compaction/estimator';
import type { EventStore } from '../events/store';
import type { AssistantActivity, Emit, EventPayloadMap, FinishReason, NewSessionEvent, TurnTrigger } from '../events/types';
import type { LlmMessage, LlmToolCall, ModelInfo, ReasoningEffort, StreamEvent, ToolSchema } from '../llm/types';
import type { LlmRegistry } from '../llm/registry';
import { assembleSystemPrompt } from '../prompt/assemble';
import type { PromptEnvironment, PromptRuntime } from '../prompt/sections';
import { createId } from '../shared/id';
import type { AgentStatus, LiveEvent, PermissionMode, TokenUsage } from '../shared/types';
import { CANCELLED_RESULT, MAX_TOOL_CALLS_PER_STEP as PIPELINE_CALL_LIMIT } from '../tools/pipeline';
import type { ToolPipeline } from '../tools/pipeline';
import type { ToolRegistry } from '../tools/registry';
import type { McpGateway, ToolImage, ToolResultStatus, ToolRunContext } from '../tools/types';
import type { Inbox } from './inbox';
import { RepeatGuard } from './repeatGuard';
import { planActiveOf } from '../plan/mode';
import { runWithRetry } from './retry';
import type { ProviderFailure, RetryTaskResult } from './retry';

/** Hard caps the loop enforces; Task 17/18 surface them to the client. */
export const MAX_STEPS_PER_TURN = 24;
export const MAX_TOOL_CALLS_PER_STEP = PIPELINE_CALL_LIMIT;
export const TURN_TIMEOUT_MS = 600_000;

export const TURN_TIMEOUT_CODE = 'TURN_TIMEOUT';
export const TOO_MANY_TOOL_CALLS_CODE = 'TOO_MANY_TOOL_CALLS';
export const CONTEXT_TRIMMED_CODE = 'CONTEXT_TRIMMED';
export const CONTEXT_OVERFLOW_CODE = 'CONTEXT_OVERFLOW';
export const AGENT_ERROR_CODE = 'AGENT_ERROR';

export type TurnStatus = 'completed' | 'cancelled' | 'max_steps' | 'error';

/** A file/image the composer attached to the turn. `data` is raw base64 (no `data:` prefix). */
export interface ChatAttachmentInput {
  name: string;
  mime: string;
  size: number;
  data: string;
}

export interface AgentTurnInput {
  sessionId: string;
  content?: string;
  modelSelection: string;
  trigger: TurnTrigger;
  effort?: ReasoningEffort;
  /** Language the user prefers for the assistant's replies; absent means follow the message. */
  language?: 'vi' | 'en';
  /** Global approval override for the turn; absent means the server default (`balanced`). */
  permissionMode?: PermissionMode;
  /** Tool allowlist for this turn (subagent child); absent means the full visible schema set. */
  toolSubset?: string[];
  /** Output cap for this turn; subagents pass a smaller cap (see SubagentRunner). */
  maxTokens?: number;
  /** Files/images staged in the composer; the loop carries them on the turn but does not yet
   * feed them to a provider — multimodal consumption is a separate follow-up. */
  attachments?: ChatAttachmentInput[];
  /** Provenance recorded on the opening `user/message` row (default `user`). Runtime-delivered
   * background completions use `notice` so the transcript never shows them as a user bubble. */
  messageSource?: 'user' | 'steer' | 'notice';
  signal: AbortSignal;
  regeneratedFrom?: { userMessageId: string; supersedesAssistantMessageId: string };
}

export interface TurnResult {
  turnId: string;
  status: TurnStatus;
}

/** Prompt input a composition root can add per turn; the loop owns model, goal, plan and MCP state. */
export interface AgentPromptContext {
  sessionId: string;
  turnId: string;
  model: ModelInfo;
  window: number;
  goal?: string;
  planActive?: boolean;
  /** The user message that started this turn, so a prompt hook can select skills by trigger. */
  message?: string;
}

export interface AgentPromptOptions {
  environment?: PromptEnvironment;
  runtime?: PromptRuntime;
  planActive?: boolean;
  workspaceInstructions?: string;
  sessionRefs?: string[];
  /** Model-facing skill summaries (the live catalog); the named bodies stay in `skills`. */
  skillCatalog?: Array<{ name: string; description: string }>;
  skills?: string[];
  instructions?: string;
}

export interface AgentLoopDeps {
  events: EventStore;
  llm: LlmRegistry;
  tools: ToolRegistry;
  pipeline: ToolPipeline;
  compaction: CompactionService;
  inbox: Inbox;
  mcp: McpGateway;
  /**
   * Task 31B Step 5: the per-session tool switches Tasks 17-18 expose were cosmetic because the
   * unfiltered schema array went to the provider. This is the single source of truth for both the
   * advertised list and the executable registry.
   */
  toolPrefs?: { isEnabled(sessionId: string, name: string): boolean };
  prompt?: (context: AgentPromptContext) => AgentPromptOptions;
  /** Durable attachment storage; when present, turn attachments are persisted before the message commits. */
  attachments?: { save: (sessionId: string, messageId: string, input: ChatAttachmentInput) => { id: string; name: string; mime: string; size: number } };
}

/** One provider step: everything the `assistant/message` row will carry. */
interface AssistantDraft {
  text: string;
  reasoning: string;
  finishReason: FinishReason;
  usage?: TokenUsage;
  calls: LlmToolCall[];
  activity: AssistantActivity[];
}

interface Turn {
  sessionId: string;
  turnId: string;
  message?: string;
  modelSelection: string;
  effort?: ReasoningEffort;
  /** User's preferred reply language for this turn (settings AI language). */
  language?: 'vi' | 'en';
  permissionMode?: PermissionMode;
  toolSubset?: string[];
  /** Output cap sent to the provider; subagents get a smaller cap to stay under OpenRouter balances. */
  maxTokens?: number;
  signal: AbortSignal;
  schemas: ToolSchema[];
  /** Image attachments carried from the composer for this turn (vision models only). */
  attachments?: ChatAttachmentInput[];
}

interface ContextFit {
  messages: LlmMessage[];
  trimmed: boolean;
  failure?: ProviderFailure;
}

type TurnOutcome = { status: TurnStatus; error?: ProviderFailure };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A thrown error only reaches the loop for wiring failures, and `NoProviderError` carries
 * `code: 'NO_PROVIDER'`, so the code is read structurally instead of importing the class.
 */
function pushActivity(activity: AssistantActivity[], kind: 'thinking' | 'text', text: string): void {
  const last = activity[activity.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.text += text;
    return;
  }
  activity.push({ kind, text });
}

function failureFromThrown(error: unknown, partial?: string): ProviderFailure {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    code: typeof code === 'string' ? code : AGENT_ERROR_CODE,
    message: messageOf(error),
    retryable: false,
    ...(partial ? { partial } : {}),
  };
}

function cancelledDraft(draft: AssistantDraft): RetryTaskResult<AssistantDraft> {
  return {
    ok: false,
    error: {
      code: CANCELLED_RESULT,
      message: 'The provider stream was cancelled.',
      retryable: false,
      ...(draft.text ? { partial: draft.text } : {}),
    },
  };
}

/** A provider that streamed argument deltas but never closed the call still has to be parsed. */
function parseArgs(raw: string | undefined): unknown {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function progressMessage(name: string, status: ToolResultStatus): string {
  if (status === 'done') return `${name} completed`;
  if (status === 'error') return `${name} failed`;
  return `${name} cancelled`;
}

function emitStatus(emit: Emit, turnId: string, state: AgentStatus): void {
  emit.live({ type: 'agent/status', payload: { state, turnId } });
}

/**
 * Task 31B Step 5 — the advertised half of the per-session tool switch. A tool the user turned off
 * must not appear in the provider request; the pipeline independently refuses to execute it, so an
 * invented call cannot bypass the switch either.
 */
export function visibleToolSchemas(
  schemas: ToolSchema[],
  prefs: { isEnabled(sessionId: string, name: string): boolean } | undefined,
  sessionId: string,
): ToolSchema[] {
  return prefs ? schemas.filter((schema) => prefs.isEnabled(sessionId, schema.name)) : schemas;
}

/**
 * The turn loop: one provider request per step, at most one tool batch per step, and exactly one
 * `turn/end` whatever the exit path. Durable rows leave through `emit.durable` (the route's sink
 * persists them), transient frames through `emit.live`.
 */
export class AgentLoop {
  private events: EventStore;
  private llm: LlmRegistry;
  private tools: ToolRegistry;
  private pipeline: ToolPipeline;
  private compaction: CompactionService;
  private inbox: Inbox;
  private mcp: McpGateway;
  private toolPrefs?: { isEnabled(sessionId: string, name: string): boolean };
  private promptInput?: (context: AgentPromptContext) => AgentPromptOptions;
  private attachmentStore?: { save: (sessionId: string, messageId: string, input: ChatAttachmentInput) => { id: string; name: string; mime: string; size: number } };
  private repeatGuard = new RepeatGuard();

  constructor(deps: AgentLoopDeps) {
    this.events = deps.events;
    this.llm = deps.llm;
    this.tools = deps.tools;
    this.pipeline = deps.pipeline;
    this.compaction = deps.compaction;
    this.inbox = deps.inbox;
    this.mcp = deps.mcp;
    this.toolPrefs = deps.toolPrefs;
    this.promptInput = deps.prompt;
    this.attachmentStore = deps.attachments;
  }

  async runTurn(input: AgentTurnInput, emit: Emit): Promise<TurnResult> {
    const turnId = createId('turn');
    // An image-only turn carries no text but is still a fresh user instruction.
    const hasUserMessage = Boolean(input.content) || (input.attachments !== undefined && input.attachments.length > 0);
    // A fresh instruction is never a loop: the guard chain resets on a new user turn.
    if (hasUserMessage) this.repeatGuard.reset(input.sessionId);
    const controller = new AbortController();
    let timedOut = false;
    const onInputAbort = (): void => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onInputAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TURN_TIMEOUT_MS);
    timer.unref?.();

    emit.durable({
      type: 'turn/start',
      payload: {
        turnId,
        modelSelection: input.modelSelection,
        trigger: input.trigger || 'user',
        ...(input.regeneratedFrom ? { regeneratedFrom: input.regeneratedFrom } : {}),
      },
    });
    if (hasUserMessage) {
      // Appended once, here: `buildContext` derives this message from the event log.
      // Durable attachments: persist (image + file) before the message commits, so the
      // log never references a failed normalization (deepseek admission rule).
      const messageId = createId('msg');
      let refs: Array<{ id: string; name: string; mime: string; size: number }> | undefined;
      if (input.attachments && input.attachments.length > 0 && this.attachmentStore) {
        refs = input.attachments.map((attachment) => {
          const saved = this.attachmentStore!.save(input.sessionId, messageId, attachment);
          return { id: saved.id, name: saved.name, mime: saved.mime, size: saved.size };
        });
      } else if (input.attachments && input.attachments.length > 0) {
        refs = input.attachments.map((attachment, index) => ({
          id: `ephemeral-${index}`,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
        }));
      }
      emit.durable({
        type: 'user/message',
        payload: {
          messageId,
          content: input.content ?? '',
          source: input.messageSource ?? 'user',
          ...(refs !== undefined ? { attachments: refs } : {}),
        },
      });
    }
    emitStatus(emit, turnId, 'thinking');

    const turn: Turn = {
      sessionId: input.sessionId,
      turnId,
      ...(input.content === undefined ? {} : { message: input.content }),
      modelSelection: input.modelSelection,
      // The turn's own signal, so a timeout cancels the stream and the tools like a Stop does.
      signal: controller.signal,
      schemas: this.visibleSchemas(input.sessionId, input.toolSubset),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.toolSubset === undefined ? {} : { toolSubset: input.toolSubset }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    };

    let outcome: TurnOutcome;
    try {
      outcome = await this.runSteps(turn, emit);
      if (timedOut && outcome.status === 'cancelled') {
        outcome = {
          status: 'error',
          error: {
            code: TURN_TIMEOUT_CODE,
            message: `The turn exceeded the ${Math.round(TURN_TIMEOUT_MS / 1000)}s limit.`,
            retryable: false,
          },
        };
      }
    } catch (error) {
      outcome = { status: 'error', error: failureFromThrown(error) };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onInputAbort);
      // The only escape from a session's tool gate: a hung tool would otherwise freeze that
      // session's whole toolkit for every later turn.
      this.pipeline.releaseSession(input.sessionId);
    }

    // Persist the provider failure with the terminal row (deepseek `turn/end reason.failure`): the
    // live `error` frame is ephemeral, so without this a reload/reopen silently forgot that the turn
    // failed. The next `turn/start` clears it by being the latest boundary.
    emit.durable({
      type: 'turn/end',
      payload: {
        turnId,
        reason: outcome.status,
        ...(outcome.error
          ? { error: { code: outcome.error.code, message: outcome.error.message, retryable: outcome.error.retryable } }
          : {}),
      },
    });
    if (outcome.status === 'cancelled') emitStatus(emit, turnId, 'cancelled');
    if (outcome.error) {
      // `retryable` được THĂNG từ failure của adapter, không hard-code `false` nữa:
      // `runSteps` gấp `failure = { ...event.error }` (dòng 411) và `retry.ts:93` trả về
      // failure nguyên vẹn sau khi hết ngân sách thử lại nội bộ, nên cờ của adapter sống tới đây.
      // Adapter chỉ bật `true` cho 429/≥500 (gemini.ts:129, openaiCompatible.ts:141) và lỗi mạng lúc
      // mở/đóng stream (gemini.ts:117,238 / openaiCompatible.ts:129,265); thiếu key (gemini.ts:98),
      // body rỗng (gemini.ts:140 / openaiCompatible.ts:152) và error ném ra (`failureFromThrown`) vẫn
      // `false`. Ngân sách nội bộ đã cạn KHÔNG liên quan: bấm Thử lại mở một LƯỢT MỚI, không tiếp tục
      // attempt thứ mười hai. Vì vậy nhãn `retryable` trên khung error phải mô tả đúng bản chất lỗi.
      emit.live({
        type: 'error',
        payload: { code: outcome.error.code, message: outcome.error.message, retryable: outcome.error.retryable },
      });
    }
    emitStatus(emit, turnId, 'idle');
    return { turnId, status: outcome.status };
  }

  private async runSteps(turn: Turn, emit: Emit): Promise<TurnOutcome> {
    let model: ModelInfo;
    try {
      model = this.llm.resolve(turn.modelSelection).model;
    } catch (error) {
      return { status: 'error', error: failureFromThrown(error) };
    }
    // Task 31C: the model's own context minus room for its answer. A 200k model gets 192k of prompt
    // budget; an 8k model gets 6.4k, and the tool budget below shrinks with it.
    const window = effectiveWindow(model.context);
    // Task 31C: the tool surface is part of the prompt, so it is fitted to the same window. Budgeting
    // is done against the prompt WITHOUT the tool list — otherwise one huge description inflates the
    // prompt that is supposed to measure whether that description fits.
    // A model whose catalogue entry says "no tools" never receives tool definitions, even when the
    // registry resolved it explicitly: some routers 404 on the tool filter otherwise.
    const basePrompt = this.systemPrompt({ ...turn, schemas: [] }, model, window);
    const tools = model.supportsTools === false ? [] : fitToolsToWindow(basePrompt, window, turn.schemas);
    const prompt = this.systemPrompt({ ...turn, schemas: tools }, model, window);
    // Screenshots tools produced earlier in THIS turn; context-only, like the composer's images.
    const toolImages: ToolImage[] = [];

    for (let index = 0; index < MAX_STEPS_PER_TURN; index += 1) {
      if (turn.signal.aborted) return { status: 'cancelled' };
      if (index > 0) emitStatus(emit, turn.turnId, 'thinking');

      for (const entry of index > 0 ? this.inbox.drainEntries(turn.sessionId) : []) {
        emit.durable({ type: 'user/message', payload: { messageId: createId('msg'), content: entry.content, source: entry.source } });
      }

      const stepId = createId('step');
      emit.durable({ type: 'step/start', payload: { stepId, index } });

      const context = await this.compaction.buildContext(turn.sessionId, window);
      const fit = this.fitToWindow(prompt, context, window);
      if (fit.failure) return { status: 'error', error: fit.failure };
      if (fit.trimmed) {
        emit.live({
          type: 'error',
          payload: {
            code: CONTEXT_TRIMMED_CODE,
            message: `Older context was dropped to fit the ${window} token window.`,
            retryable: false,
          },
        });
      }

      // Vision: image attachments ride the turn's last user message, but only for models whose
      // catalogue declares image input. A text-only model never sees the pixels (and never 422s —
      // the pixels are dropped, the text still goes through). Historical images re-projected by
      // compaction are stripped here for the same reason (deepseek placeholder vs Morphi drop:
      // the content stays, the bytes do not).
      if (model.supportsImages !== false) {
        const turnImages = (turn.attachments ?? [])
          .filter((attachment) => attachment.mime.startsWith('image/'))
          .map((attachment) => ({ mime: attachment.mime, data: attachment.data }));
        const images = [...turnImages, ...toolImages];
        if (images.length > 0) {
          for (let index = fit.messages.length - 1; index >= 0; index -= 1) {
            const message = fit.messages[index];
            if (message.role === 'user') {
              fit.messages[index] = { ...message, imageParts: images };
              break;
            }
          }
        }
      } else {
        for (let index = 0; index < fit.messages.length; index += 1) {
          const message = fit.messages[index];
          if (message.imageParts !== undefined) {
            const { imageParts: _stripped, ...rest } = message;
            fit.messages[index] = rest;
          }
        }
      }

      const result = await this.requestStep(turn, fit.messages, tools, emit);
      if (!result.ok) {
        if (turn.signal.aborted) return { status: 'cancelled' };
        return { status: 'error', error: result.error };
      }

      const draft = result.value;
      const dispatched = draft.calls.slice(0, MAX_TOOL_CALLS_PER_STEP);
      if (draft.text || draft.reasoning || dispatched.length > 0) {
        emit.durable({
          type: 'assistant/message',
          payload: {
            messageId: createId('msg'),
            content: draft.text,
            ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
            finishReason: draft.finishReason,
            ...(draft.usage ? { usage: draft.usage } : {}),
            callIds: dispatched.map((call) => call.id),
            activity: draft.activity,
          },
        });
      }
      if (dispatched.length === 0) return { status: 'completed' };

      if (dispatched.length < draft.calls.length) {
        emit.live({
          type: 'error',
          payload: {
            code: TOO_MANY_TOOL_CALLS_CODE,
            message: `The provider asked for ${draft.calls.length} tool calls; only ${MAX_TOOL_CALLS_PER_STEP} run per step.`,
            retryable: false,
          },
        });
      }

      emitStatus(emit, turn.turnId, 'tool');
      const toolResults = await this.pipeline.run(dispatched, {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        stepId,
        signal: turn.signal,
        emit: this.toolEvents(emit, turn.turnId, dispatched),
        mcp: this.mcp,
        outputBudgetChars: toolOutputBudgetChars(window),
        ...(turn.permissionMode === undefined ? {} : { permissionMode: turn.permissionMode }),
      } satisfies ToolRunContext);
      for (const toolResult of toolResults) {
        if (toolResult.images) toolImages.push(...toolResult.images);
      }
      // Advisory loop hygiene: an exact-repeat chain reminds the model via a logged
      // steer message, so it is model-visible and reconstructable from the session log.
      for (const call of dispatched) {
        const reminder = this.repeatGuard.note(turn.sessionId, call.name, call.args);
        if (reminder) {
          emit.durable({
            type: 'user/message',
            payload: { messageId: createId('msg'), content: reminder, source: 'steer' },
          });
        }
      }
      if (turn.signal.aborted) return { status: 'cancelled' };
    }

    return { status: 'max_steps' };
  }

  private async requestStep(turn: Turn, messages: LlmMessage[], tools: ToolSchema[], emit: Emit): Promise<RetryTaskResult<AssistantDraft>> {
    return runWithRetry<AssistantDraft>({
      signal: turn.signal,
      run: () => this.streamAttempt(turn, messages, tools, emit),
      onFailure: (failure) => {
        // A cancel with nothing streamed leaves no result worth a row; a partial answer does.
        if (failure.code === CANCELLED_RESULT && !failure.partial) return;
        emit.durable({
          type: 'assistant/attempt',
          payload: { attemptId: createId('attempt'), error: failure.message, retryable: failure.retryable, finishedAt: Date.now() },
        });
      },
    });
  }

  private async streamAttempt(turn: Turn, messages: LlmMessage[], tools: ToolSchema[], emit: Emit): Promise<RetryTaskResult<AssistantDraft>> {
    const draft: AssistantDraft = { text: '', reasoning: '', finishReason: 'stop', calls: [], activity: [] };
    const pending = new Map<string, { name: string; args: string }>();
    let failure: ProviderFailure | undefined;

    // `LlmRegistry.stream` resolves the adapter synchronously, so the call itself is guarded.
    let stream: AsyncIterable<StreamEvent>;
    try {
      stream = this.llm.stream(turn.modelSelection, {
        messages,
        tools,
        ...(turn.effort === undefined ? {} : { effort: turn.effort }),
        ...(turn.maxTokens === undefined ? {} : { maxTokens: turn.maxTokens }),
        signal: turn.signal,
      });
    } catch (error) {
      return { ok: false, error: failureFromThrown(error) };
    }

    try {
      for await (const event of stream) {
        if (turn.signal.aborted) break;
        switch (event.type) {
          case 'text_delta':
            draft.text += event.text;
            pushActivity(draft.activity, 'text', event.text);
            emit.live({ type: 'assistant/delta', payload: { turnId: turn.turnId, text: event.text } });
            break;
          case 'reasoning_delta':
            draft.reasoning += event.text;
            pushActivity(draft.activity, 'thinking', event.text);
            emit.live({ type: 'thought/delta', payload: { turnId: turn.turnId, text: event.text } });
            break;
          case 'tool_call_start':
            pending.set(event.callId, { name: event.name, args: '' });
            break;
          case 'tool_call_delta': {
            const entry = pending.get(event.callId) ?? { name: '', args: '' };
            entry.args += event.argsDelta;
            pending.set(event.callId, entry);
            break;
          }
          case 'tool_call_end': {
            const entry = pending.get(event.callId);
            const args = event.args === undefined ? parseArgs(entry?.args) : event.args;
            draft.calls.push({ id: event.callId, name: event.name || entry?.name || '', args });
            draft.activity.push({ kind: 'call', callId: event.callId });
            pending.delete(event.callId);
            break;
          }
          case 'usage':
            // Stored only when the provider reports it; the loop never invents a number.
            draft.usage = event.usage;
            break;
          case 'error':
            failure = { ...event.error, partial: draft.text || failure?.partial };
            break;
          case 'finish':
            draft.finishReason = event.reason;
            if (event.reason === 'error' && !failure) {
              failure = { code: 'stream_error', message: 'The provider stream failed.', retryable: false };
            }
            break;
        }
      }
    } catch (error) {
      if (turn.signal.aborted) return cancelledDraft(draft);
      return { ok: false, error: failureFromThrown(error, draft.text || undefined) };
    }

    if (turn.signal.aborted || draft.finishReason === 'cancelled') return cancelledDraft(draft);
    if (failure) return { ok: false, error: failure };
    return { ok: true, value: draft };
  }

  /**
   * The pipeline emits `tool/call`, `tool/result` and approval rows through this sink. It is where
   * the loop leaves the status Task 14 parks at `waiting_approval` again, and where a settled call
   * becomes a real `tool/progress` frame.
   */
  private toolEvents(emit: Emit, turnId: string, calls: LlmToolCall[]): Emit {
    const names = new Map(calls.map((call) => [call.id, call.name] as [string, string]));
    let waiting = 0;
    return {
      durable: (event: NewSessionEvent) => {
        emit.durable(event);
        if (event.type === 'approval/request') {
          waiting += 1;
          return;
        }
        if (event.type === 'approval/decision') {
          waiting = Math.max(0, waiting - 1);
          if (waiting === 0) emitStatus(emit, turnId, 'tool');
          return;
        }
        if (event.type === 'tool/result') {
          const payload = event.payload as EventPayloadMap['tool/result'];
          emit.live({
            type: 'tool/progress',
            payload: {
              callId: payload.callId,
              message: progressMessage(names.get(payload.callId) ?? payload.callId, payload.status),
            },
          });
        }
      },
      live: (event: LiveEvent) => emit.live(event),
    };
  }

  private systemPrompt(turn: Turn, model: ModelInfo, window: number): string {
    const goal = this.activeGoal(turn.sessionId);
    const planActive = planActiveOf(this.events, turn.sessionId);
    const todos = this.latestTodos(turn.sessionId);
    const time = new Date().toISOString();
    const extra = this.promptInput?.({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      model,
      window,
      ...(goal === undefined ? {} : { goal }),
      ...(planActive ? { planActive } : {}),
      ...(turn.message === undefined ? {} : { message: turn.message }),
    }) ?? { planActive };
    // Hook first, gateway last: the MCP state is read live, so a Task 17 hook cannot override it.
    const environment: PromptEnvironment = {
      ...extra.environment,
      mcpConnected: this.mcp.connected,
      studioLinked: this.mcp.studioLinked,
    };
    // The model and the logged goal are authoritative; the hook can only add fields to them.
    const runtime: PromptRuntime = {
      ...extra.runtime,
      model: model.id,
      ...(turn.language === undefined ? {} : { language: turn.language }),
      ...(goal ? { goal } : {}),
      ...(todos.length ? { todos } : {}),
      time,
    };

    return assembleSystemPrompt({
      tools: turn.schemas,
      environment,
      runtime,
      planActive: planActive || extra.planActive === true,
      ...(extra.workspaceInstructions ? { workspaceInstructions: extra.workspaceInstructions } : {}),
      ...(extra.sessionRefs && extra.sessionRefs.length ? { sessionRefs: extra.sessionRefs } : {}),
      ...(extra.skillCatalog?.length ? { skillCatalog: extra.skillCatalog } : {}),
      ...(extra.skills ? { skills: extra.skills } : {}),
      ...(extra.instructions ? { instructions: extra.instructions } : {}),
    });
  }

  /**
   * The tools this session is actually allowed to use. The provider must not see a disabled tool:
   * a schema that is offered but unexecutable is the exact "dead control" §6.6.2 forbids, and the
   * pipeline independently refuses a disabled name in case the model invents it anyway.
   * Subagents pass a `toolSubset` (approval-free only) that narrows this list further.
   */
  private visibleSchemas(sessionId: string, subset?: string[]): ToolSchema[] {
    const all = visibleToolSchemas(this.tools.schemas(), this.toolPrefs, sessionId);
    if (!subset) return all;
    const allowed = new Set(subset);
    return all.filter((schema) => allowed.has(schema.name));
  }

  /** The most recent goal that is still being worked on, read off the session's own event log. */
  private activeGoal(sessionId: string): string | undefined {
    const rows = this.events.list(sessionId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].type !== 'goal/changed') continue;
      const payload = rows[index].payload as EventPayloadMap['goal/changed'];
      return payload.status === 'active' ? payload.objective : undefined;
    }
    return undefined;
  }

  /** The session's durable todo list (last `todo/write` wins), for the runtime context. */
  private latestTodos(sessionId: string): Array<{ title: string; status: 'todo' | 'doing' | 'done' }> {
    const rows = this.events.list(sessionId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].type !== 'todo/write') continue;
      return (rows[index].payload as EventPayloadMap['todo/write']).todos;
    }
    return [];
  }

  /**
   * Compaction can leave a context over the window with nothing compactable (the turn count sits
   * at or below `keepRecentTurns`), so the request is trimmed here: the system block (assembled
   * prompt plus every compaction summary, in order) stays and the newest message stays; the kept
   * history realigns to a leading user message only when one falls inside the fitted window, so a
   * window holding no user message is kept as-is even if it opens on an orphaned head — dropping
   * it would cut a call from the result still paired to it. When even that does not fit
   * the turn ends instead of re-requesting against a threshold that can never clear.
   */
  private fitToWindow(prompt: string, context: LlmMessage[], window: number): ContextFit {
    const messages: LlmMessage[] = [{ role: 'system', content: prompt }, ...context];
    if (estimateTokens(messages) <= window) return { messages, trimmed: false };

    const head = messages.filter((message) => message.role === 'system');
    const history = messages.filter((message) => message.role !== 'system');
    const newest = history[history.length - 1];
    const budget = window - estimateTokens(head);
    if (!newest || budget <= 0 || estimateTokens([newest]) > budget) {
      const needed = estimateTokens(head) + (newest ? estimateTokens([newest]) : 0);
      return {
        messages: [],
        trimmed: false,
        failure: {
          code: CONTEXT_OVERFLOW_CODE,
          message: `The prompt and the newest message need ${needed} tokens, over the ${window} token window.`,
          retryable: false,
        },
      };
    }

    let start = history.length - 1;
    let used = estimateTokens([newest]);
    while (start > 0 && used + estimateTokens([history[start - 1]]) <= budget) {
      start -= 1;
      used += estimateTokens([history[start]]);
    }
    const offset = history.slice(start).findIndex((message) => message.role === 'user');
    const from = offset === -1 ? start : start + offset;
    return { messages: [...head, ...history.slice(from)], trimmed: from > 0 };
  }
}
