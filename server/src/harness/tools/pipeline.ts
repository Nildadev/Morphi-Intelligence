import Ajv, { type Schema, type ValidateFunction } from 'ajv';
import type { LlmToolCall } from '../llm/types';
import { formatSpillNotice, hasSpillNotice, retainHeadTail } from '../spill/notice';
import type { SpillStore } from '../spill/store';
import type { ApprovalService } from './approval';
import type { ToolRegistry } from './registry';
import { extractTargets, hashArgs, type CheckpointStore } from '../checkpoints/store';
import { isRestorable, snapshotPostState, snapshotPreState } from '../checkpoints/snapshot';
import type { ToolContext, ToolDefinition, ToolImage, ToolResultStatus, ToolRunContext, ToolRunResult } from './types';
import { isToolImageOutput } from './types';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_OUTPUT_CHARS = 50_000;
export const TOOL_CONCURRENCY_LIMIT = 4;
/** Tool calls one agent step may dispatch; Task 16 enforces it, Task 18/23 read it. */
export const MAX_TOOL_CALLS_PER_STEP = 8;

const ajvDefaults = { allErrors: true, strict: false } as const;

/**
 * Codes a call is settled with when it never reached (or never finished) its tool body. They are
 * the wire vocabulary Tasks 16/18/23 match on the literals, so they are exported as values too to
 * give consumers one source of truth; the `tool/result` payload itself stays `unknown`.
 */
export type ToolResultCode =
  | 'APPROVAL_DENIED'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGS'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_TIMEOUT'
  | 'TOOL_DISABLED'
  | 'CANCELLED';

export const APPROVAL_DENIED_RESULT: ToolResultCode = 'APPROVAL_DENIED';
export const UNKNOWN_TOOL_RESULT: ToolResultCode = 'UNKNOWN_TOOL';
export const INVALID_ARGS_RESULT: ToolResultCode = 'INVALID_ARGS';
export const TOOL_UNAVAILABLE_RESULT: ToolResultCode = 'TOOL_UNAVAILABLE';
export const TOOL_TIMEOUT_RESULT: ToolResultCode = 'TOOL_TIMEOUT';
export const TOOL_DISABLED_RESULT: ToolResultCode = 'TOOL_DISABLED';
export const CANCELLED_RESULT: ToolResultCode = 'CANCELLED';

/** Codes a call can be rejected with before its tool runs. */
type ResultCode = typeof INVALID_ARGS_RESULT | typeof TOOL_UNAVAILABLE_RESULT;

/**
 * Task 31B Step 6: a silent slice made `search_asset` / `get_console_output` look complete while
 * dropping the rest. The marker states the original size and how to page, so the model can ask for
 * the next slice instead of concluding the data ended.
 */
function capText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  // The marker names the cap that was applied, so the model can tell a 1 000-char budget on a small
  // model from the 50 000-char ceiling on a large one.
  const marker = `\n\n[đã cắt bớt: ${value.length} ký tự gốc, giữ ${limit}; dùng head_limit/max_results để lấy phần tiếp theo]`;
  return `${value.slice(0, limit)}${marker}`;
}

/**
 * The 50,000 character budget applies to the serialized form: strings are capped
 * directly, oversized objects are stored as their truncated JSON text, and anything
 * small enough keeps its structured shape.
 */
export function capToolOutput(result: unknown, limit = MAX_TOOL_OUTPUT_CHARS): unknown {
  if (typeof result === 'string') return capText(result, limit);
  if (result === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) return capText(String(result), limit);
  return serialized.length > limit ? capText(serialized, limit) : result;
}

/**
 * Best-effort spill policy (deepseek `dsh-spill-policy`): when the serialized result exceeds
 * the budget, save the full text to the spill store and return a head/tail preview + locator.
 * A storage failure keeps the original inline (degraded to the old truncating marker), so a
 * spill failure never turns a successful tool call into an error.
 */
function spillToolOutput(
  result: unknown,
  limit: number,
  store: SpillStore | undefined,
  meta: { sessionId: string; toolName: string; callId: string },
): unknown {
  if (typeof result === 'string') {
    if (result.length <= limit || !store) return capToolOutput(result, limit);
    try {
      const ref = store.saveText({
        owner: { sessionId: meta.sessionId },
        source: { kind: 'tool', toolName: meta.toolName, callId: meta.callId, label: 'result' },
        suggestedName: `${meta.toolName}.txt`,
        content: result,
      });
      const omitted = result.length - 0;
      const notice = formatSpillNotice(omitted, ref, result.length);
      if (hasSpillNotice(result)) return result; // A tool already printing the notice passes through.
      const preview = retainHeadTail(result, limit, notice);
      // If the notice itself cannot fit, the helper returned the original; never substitute an unreadable path.
      if (preview === result) return capToolOutput(result, limit);
      return preview;
    } catch (error) {
      console.warn(`[harness] spill failed for ${meta.toolName}: ${messageOf(error)}`);
      return capToolOutput(result, limit);
    }
  }
  if (result === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    const text = String(result);
    return spillToolOutput(text, limit, store, meta);
  }
  if (serialized.length <= limit || !store) return capToolOutput(result, limit);
  try {
    const ref = store.saveText({
      owner: { sessionId: meta.sessionId },
      source: { kind: 'tool', toolName: meta.toolName, callId: meta.callId, label: 'result' },
      suggestedName: `${meta.toolName}.json`,
      content: serialized,
    });
    const notice = formatSpillNotice(serialized.length, ref, serialized.length);
    const preview = retainHeadTail(serialized, limit, notice);
    if (preview === serialized) return capToolOutput(result, limit);
    return preview;
  } catch (error) {
    console.warn(`[harness] spill failed for ${meta.toolName}: ${messageOf(error)}`);
    return capToolOutput(result, limit);
  }
}

/**
 * The tighter of the two budgets: what this tool may return, and what the turn's model window can
 * afford. A 22 803-char `search_game_tree` on an 8k model is trimmed by the window, not by luck.
 */
function outputLimit(tool: ToolDefinition, context: ToolRunContext): number {
  return Math.min(
    context.outputBudgetChars ?? MAX_TOOL_OUTPUT_CHARS,
    tool.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start stamps are keyed by position *and* id: a sloppy provider can repeat a
 * `call.id` across calls in one step, and a shared key would make the later call
 * overwrite the earlier one's start time and skew its `durationMs`.
 */
function startKey(index: number, id: string): string {
  return `${index}\u0000${id}`;
}

interface Waiter {
  exclusive: boolean;
  grant: () => void;
}

/**
 * Serial tools act as a barrier: the queue is served strictly in call order, so a
 * concurrency-unsafe call blocks later calls until it has run alone, and safe calls
 * never exceed the pool size while it holds the gate.
 *
 * One instance exists per session id (see `ToolPipeline.gateFor`), so an exclusive
 * grant also serialises the next step and the next turn of that session.
 */
class ExecutionGate {
  private queue: Waiter[] = [];
  private safeRunning = 0;
  private exclusiveRunning = false;

  /**
   * Resolves `true` once the caller owns the slot and must `release` it, or `false`
   * when the turn was cancelled while it waited (Stop must be able to abandon the
   * queue even though a hung tool keeps its slot booked).
   */
  acquire(isConcurrencySafe: boolean, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.queue.length === 0 && this.canStart(isConcurrencySafe)) {
      this.start(isConcurrencySafe);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        exclusive: !isConcurrencySafe,
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        },
      };
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        resolve(false);
      };
      this.queue.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(isConcurrencySafe: boolean): void {
    if (isConcurrencySafe) this.safeRunning = Math.max(0, this.safeRunning - 1);
    else this.exclusiveRunning = false;
    this.pump();
  }

  private canStart(isConcurrencySafe: boolean): boolean {
    if (this.exclusiveRunning) return false;
    return isConcurrencySafe ? this.safeRunning < TOOL_CONCURRENCY_LIMIT : this.safeRunning === 0;
  }

  private start(isConcurrencySafe: boolean): void {
    if (isConcurrencySafe) this.safeRunning += 1;
    else this.exclusiveRunning = true;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const isConcurrencySafe = !head.exclusive;
      if (!this.canStart(isConcurrencySafe)) return;
      this.queue.shift();
      this.start(isConcurrencySafe);
      head.grant();
    }
  }

  /** Nothing booked and nobody waiting: the session's whole toolkit is free again. */
  idle(): boolean {
    return this.queue.length === 0 && !this.exclusiveRunning && this.safeRunning === 0;
  }
}

export class ToolPipeline {
  private ajv = new Ajv(ajvDefaults);
  private compiledSchemas = new WeakMap<object, ValidateFunction>();
  /** One gate per session id, created lazily, so grants span steps and turns. */
  private gates = new Map<string, ExecutionGate>();
  private schemaDefects = new Set<string>();

  constructor(
    private registry: ToolRegistry,
    private approval: ApprovalService,
    /** Task 31B Step 5: the executable half of the same per-session switch the loop advertises. */
    private isEnabled?: (sessionId: string, name: string) => boolean,
    private spill?: SpillStore,
    /** Phase 2 audit: records one checkpoint per mutating Studio tool call. Best-effort. */
    private checkpoints?: CheckpointStore,
  ) {}

  /**
   * Drop a session's gate when its turn/loop ends (Task 16/17 call this).
   *
   * A timed-out tool keeps its exclusive slot until its own promise settles, so one hung
   * tool deliberately stalls that session's next write on purpose: two mutations never
   * overlap in the same Studio place, which is the safe direction, and Stop is the escape
   * hatch (an aborted turn abandons the calls queued behind it, they settle as cancelled).
   * Releasing a session forgets that debt, so only call this once the turn is really over.
   */
  releaseSession(sessionId: string): void {
    this.gates.delete(sessionId);
  }

  /**
   * Read-only probe for the route layer's per-session turn guard (Task 17/18): `false` while the
   * session still owes a grant, including the hung-tool debt `releaseSession` is the only way out
   * of. Never creates a gate, so asking about an idle session costs nothing.
   */
  canStart(sessionId: string): boolean {
    const gate = this.gates.get(sessionId);
    return gate === undefined || gate.idle();
  }

  /** The session's gate, created on first dispatch so grants span steps and turns. */
  private gateFor(sessionId: string): ExecutionGate {
    const existing = this.gates.get(sessionId);
    if (existing) return existing;
    const gate = new ExecutionGate();
    this.gates.set(sessionId, gate);
    return gate;
  }

  /** Compiled validators are cached per pipeline so a reconnect cannot pin a stale schema. */
  private validatorFor(tool: ToolDefinition): ValidateFunction {
    const schema = tool.parameters;
    const cached = this.compiledSchemas.get(schema);
    if (cached) return cached;
    const compiled = this.ajv.compile(schema as unknown as Schema);
    this.compiledSchemas.set(schema, compiled);
    return compiled;
  }

  async run(calls: LlmToolCall[], context: ToolRunContext): Promise<ToolRunResult[]> {
    if (calls.length === 0) return [];

    const startedAt = new Map<string, number>();
    for (const [index, call] of calls.entries()) {
      const started = Date.now();
      startedAt.set(startKey(index, call.id), started);
      const definition = this.registry.get(call.name);
      context.emit.durable({
        type: 'tool/call',
        payload: {
          callId: call.id,
          name: call.name,
          args: call.args,
          startedAt: started,
          // Only what the registry actually measured; an unknown tool omits both and the client
          // falls back to its own map instead of inventing a Vietnamese name.
          ...(definition ? { label: definition.presentation.label, risk: definition.presentation.risk } : {}),
        },
      });
    }

    const gate = this.gateFor(context.sessionId);
    return Promise.all(
      calls.map((call, index) => this.runOne(call, context, gate, startedAt.get(startKey(index, call.id)) ?? Date.now())),
    );
  }

  private async runOne(call: LlmToolCall, context: ToolRunContext, gate: ExecutionGate, started: number): Promise<ToolRunResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return this.settle(call, context, 'error', { error: UNKNOWN_TOOL_RESULT, message: `Tool ${call.name} is not available.` }, started);
    }
    // A tool the user switched off must not execute even if the model invents the call.
    if (this.isEnabled && !this.isEnabled(context.sessionId, call.name)) {
      return this.settle(call, context, 'error', { error: TOOL_DISABLED_RESULT, message: `Tool ${call.name} is disabled for this session.` }, started);
    }

    const invalid = this.validate(tool, call.args);
    if (invalid) return this.settle(call, context, 'error', { error: invalid.code, message: invalid.message }, started);

    const decision = await this.approval.request(
      {
        sessionId: context.sessionId,
        turnId: context.turnId,
        callId: call.id,
        name: tool.name,
        args: call.args,
        risk: tool.presentation.risk,
        approval: tool.approval,
        signal: context.signal,
      },
      context.emit,
      context.permissionMode,
    );

    if (context.signal.aborted) return this.settle(call, context, 'cancelled', { error: CANCELLED_RESULT }, started);
    if (!decision.allowed) return this.settle(call, context, 'error', { error: APPROVAL_DENIED_RESULT }, started);

    const granted = await gate.acquire(tool.isConcurrencySafe, context.signal);
    if (!granted || context.signal.aborted) {
      if (granted) gate.release(tool.isConcurrencySafe);
      return this.settle(call, context, 'cancelled', { error: CANCELLED_RESULT }, started);
    }
    const snapshotted =
      this.checkpoints !== undefined && tool.name.startsWith('studio.') && tool.presentation.risk !== 'low';
    // Phase 3: capture the pre-state BEFORE the mutation, so an inverse exists to offer. Best-effort:
    // a failed read only downgrades the checkpoint to non-restorable, it never blocks the call.
    const preState = snapshotted
      ? await snapshotPreState(context.mcp, tool.name, call.args, context.signal)
      : null;
    const result = await this.execute(tool, call, context, started, gate);
    // Phase 2: audit the mutation. Recording never changes the turn's result — a
    // store failure must not turn a successful tool call into an error.
    if (snapshotted) {
      try {
        const restorable = preState !== null && isRestorable(preState);
        // Phase 5: re-read the targets now that the call landed. `restore` compares the LIVE content
        // with this, so a hand edit made after the turn is refused instead of being overwritten —
        // without it the post-turn content is indistinguishable from a later edit. Only worth a
        // round trip when an inverse exists at all; best-effort, never throws.
        const postState = restorable && preState !== null
          ? await snapshotPostState(context.mcp, preState, context.signal)
          : null;
        this.checkpoints!.record({
          sessionId: context.sessionId,
          label: `${tool.presentation.label} · ${tool.name}`,
          manifest: {
            tool: tool.name,
            callId: call.id,
            argsHash: hashArgs(call.args),
            targets: extractTargets(call.args),
            outcome: result.status === 'done' ? 'ok' : result.status === 'cancelled' ? 'cancelled' : 'error',
            preState,
            postState,
            restorable,
            // Shown to the user verbatim, so it names the actual limitation instead of a generic
            // "cannot undo" — the snapshot module already wrote the precise reason.
            restoreReason: restorable
              ? 'Đã chụp trạng thái trước khi sửa — có thể khôi phục.'
              : (preState?.notes[0]
                ?? 'Chưa chụp được snapshot trước khi sửa — không có inverse rõ ràng để khôi phục an toàn.'),
          },
        });
      } catch (error) {
        console.warn('[harness] checkpoint record failed:', error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  private async execute(
    tool: ToolDefinition,
    call: LlmToolCall,
    context: ToolRunContext,
    started: number,
    gate: ExecutionGate,
  ): Promise<ToolRunResult> {
    const toolContext: ToolContext = { ...context, callId: call.id };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const stopped = new Promise<{ kind: 'stopped'; reason: 'timeout' | 'abort' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'stopped', reason: 'timeout' }), tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
      timer.unref?.();
      if (context.signal.aborted) {
        resolve({ kind: 'stopped', reason: 'abort' });
        return;
      }
      onAbort = () => resolve({ kind: 'stopped', reason: 'abort' });
      context.signal.addEventListener('abort', onAbort, { once: true });
    });

    const invocation = (async () => tool.execute(call.args, toolContext))();
    const release = (): void => gate.release(tool.isConcurrencySafe);
    // The slot is freed by the invocation itself, not by the race below: a tool that
    // ignores its timeout/abort must not overlap the next mutation of the same place.
    void invocation.then(release, release);

    let outcome: { kind: 'stopped'; reason: 'timeout' | 'abort' } | { kind: 'done'; value: unknown } | { kind: 'failed'; error: unknown };
    try {
      outcome = await Promise.race([
        invocation.then(
          (value) => ({ kind: 'done' as const, value }),
          (error) => ({ kind: 'failed' as const, error }),
        ),
        stopped,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) context.signal.removeEventListener('abort', onAbort);
    }

    if (outcome.kind === 'stopped') {
      // The tool keeps running in the background; its late result is discarded on purpose.
      return this.settle(
        call,
        context,
        'cancelled',
        { error: outcome.reason === 'abort' ? CANCELLED_RESULT : TOOL_TIMEOUT_RESULT },
        started,
      );
    }
    if (outcome.kind === 'failed') {
      return this.settle(call, context, 'error', { error: 'TOOL_FAILED', message: messageOf(outcome.error) }, started);
    }
    const limit = outputLimit(tool, context);
    // `{ text, images }` output: only the note is durable; the pixels ride the run result to the
    // loop, which attaches them to the next request for vision models (never the event log).
    const imageOutput = isToolImageOutput(outcome.value) ? outcome.value : undefined;
    const spilled = spillToolOutput(imageOutput ? imageOutput.text : outcome.value, limit, this.spill, {
      sessionId: context.sessionId,
      toolName: tool.name,
      callId: call.id,
    });
    return this.settle(call, context, 'done', spilled, started, imageOutput?.images);
  }

  private validate(tool: ToolDefinition, args: unknown): { code: ResultCode; message: string } | undefined {
    let validate: ValidateFunction;
    try {
      validate = this.validatorFor(tool);
    } catch (error) {
      // A schema AJV itself rejects is a registry defect, not a model error: the model
      // cannot fix it by re-typing args, so it gets its own code and one warning per tool.
      if (!this.schemaDefects.has(tool.name)) {
        this.schemaDefects.add(tool.name);
        console.warn(`[harness] tool schema for ${tool.name} cannot be compiled: ${messageOf(error)}`);
      }
      return { code: 'TOOL_UNAVAILABLE', message: `tool schema for ${tool.name} is not a valid JSON schema: ${messageOf(error)}` };
    }
    const valid = validate(args);
    if (valid) return undefined;
    return { code: 'INVALID_ARGS', message: this.ajv.errorsText(validate.errors, { separator: '; ' }) };
  }

  private settle(
    call: LlmToolCall,
    context: ToolRunContext,
    status: ToolResultStatus,
    result: unknown,
    started: number,
    images?: ToolImage[],
  ): ToolRunResult {
    const payload = { callId: call.id, status, result, durationMs: Math.max(0, Date.now() - started) };
    context.emit.durable({ type: 'tool/result', payload });
    return { callId: call.id, name: call.name, status, result, ...(images === undefined ? {} : { images }) };
  }
}
