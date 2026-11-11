import { buildToolsSystemPrompt, StreamingToolCallRouter, type ToolCallChunk } from './deepseekWebTools';
import type { ToolSchema } from './types';
import type { LlmMessage, LlmRequest, ModelInfo, ProviderAdapter, StreamEvent } from './types';

/**
 * DeepSeek WEB chat adapter — talks to chat.deepseek.com the way the signed-in web client does.
 *
 * Studied from github.com/AppsGanin/ai-free-vscode (MIT), which measured the whole wire live. This
 * replaces the dependency on the external Python bridge (`deepseek-chat`, 127.0.0.1:8000): Morphi
 * now speaks the protocol itself, so the only setup is pasting a session credential.
 *
 * The wire, as measured by that project:
 *  - Auth is a Bearer token PLUS the browser cookies (`ds_session_id` is the one that matters).
 *    Cookies alone answer 40002; the token is captured from the `Authorization` header of the first
 *    successful `/api/v0/` call in the signed-in browser.
 *  - Every request goes to `POST /api/v0/…` with browser-like headers and an `x-client-version` that
 *    must follow the live web bundle (`appVersion:"…"` inside `static/main.<hash>.js`), read with the
 *    session cookies because the home page sits behind the AWS WAF.
 *  - Mutating calls need a PROOF OF WORK: `create_pow_challenge` returns a `DeepSeekHashV1`
 *    challenge that must be solved with DeepSeek's own sha3 WASM and sent back base64-encoded in
 *    `X-DS-PoW-Response`.
 *  - `chat/completion` answers `text/event-stream` where each event is a JSON PATCH stream
 *    (`{p, o, v}`) over a growing document, with two channels (answer vs thinking), abbreviated
 *    tail patches that carry only `{v}`, and `BATCH` wrappers — see `extractDelta`.
 *  - Cancelling MUST call `chat/stop_stream`: a plain disconnect leaves the message "wip" and the
 *    session refuses the next request.
 *
 * v1 scope: text + thinking streaming, no tool calling (the web API has none; the reference project
 * injects tools via a system prompt and parses them back out of the text — a separate follow-up).
 * A fresh `chat_session` is created per request because Morphi owns the transcript and resends it.
 */

const BASE_URL = 'https://chat.deepseek.com';
const CREATE_SESSION_PATH = '/api/v0/chat_session/create';
const CREATE_POW_PATH = '/api/v0/chat/create_pow_challenge';
const COMPLETION_PATH = '/api/v0/chat/completion';
const STOP_STREAM_PATH = '/api/v0/chat/stop_stream';
/** DeepSeek's own sha3 solver; the URL carries a bundle hash, so it is overridable. */
const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
/** Last version seen by hand in the reference project; used until the live bundle is read. */
const FALLBACK_APP_VERSION = '2.7.0';
/** ~75k tokens — the reference project's budget for the 128k window. Converted to characters per
 *  conversation, because CJK text costs several times the tokens per character that latin does. */
const MAX_PROMPT_TOKENS = 75_000;
/** Web models drift to English without this; prepended when no tools prompt takes the slot. */
const LANGUAGE_GUARD =
  "Always answer in the same language as the latest user message. Never switch language unless the user explicitly asks.";
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export const DEEPSEEK_WEB_PROVIDER_ID = 'deepseek-web';

const MODELS: ModelInfo[] = [
  { id: 'deepseek-web', name: 'DeepSeek Web', provider: DEEPSEEK_WEB_PROVIDER_ID, providerLabel: 'DeepSeek Web', context: 131_072, supportsTools: true },
  // `expert` is the web client's stronger mode; it maps to `thinking_enabled: true` on the wire.
  { id: 'deepseek-web-expert', name: 'DeepSeek Web Expert (DeepThink)', provider: DEEPSEEK_WEB_PROVIDER_ID, providerLabel: 'DeepSeek Web', context: 131_072, supportsTools: true },
];

/** What a signed-in browser session gives us: the Bearer and the cookie jar. */
export interface DeepSeekAuth {
  token?: string;
  cookieHeader: string;
}

interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at?: number;
  expireAt?: number;
  signature: string;
}

interface DeepSeekJson {
  code?: number;
  msg?: string;
  data?: {
    code?: number;
    biz_code?: number;
    biz_msg?: string;
    biz_data?: {
      id?: string;
      chat_session?: { id?: string };
      challenge?: PowChallenge;
    };
  };
}

export interface DeepSeekWebOptions {
  /** Test seam: every HTTP call goes through here. */
  fetchImpl?: typeof fetch;
  /** The sha3 solver bundle; overridable because the URL carries a build hash. */
  wasmUrl?: string;
  /** Test seam: replace the WASM solver entirely. */
  solver?: (challenge: string, salt: string, difficulty: number, expireAt: number) => number | undefined;
  /** Test seam: override the backoff ladders (ms) so retry tests do not sleep for real. */
  retryDelays?: { parallelLimit?: number[]; rateLimit?: number[]; network?: number[] };
}

/** Auth-expired (40002/40003): the stored session was refused and must be re-captured. */
export class DeepSeekAuthExpiredError extends Error {
  readonly code = 'DEEPSEEK_AUTH_EXPIRED';
  constructor() {
    super('Phiên DeepSeek Web đã hết hạn — hãy đăng nhập lại và cập nhật thông tin xác thực.');
    this.name = 'DeepSeekAuthExpiredError';
  }
}

/**
 * Parse the stored credential. The Settings key field holds JSON
 * `{"token":"…","cookieHeader":"ds_session_id=…; …"}`; a bare token alone is accepted but will not
 * work without its cookies, so the message says so instead of failing later with a 40002.
 */
export function parseDeepSeekCredential(raw: string | undefined): DeepSeekAuth | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text) as { token?: unknown; cookieHeader?: unknown };
    const cookieHeader = typeof parsed.cookieHeader === 'string' ? parsed.cookieHeader.trim() : '';
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : undefined;
    if (cookieHeader !== '') return { token: token || undefined, cookieHeader };
  } catch {
    /* not JSON — fall through */
  }
  // A bare Bearer without cookies cannot answer (cookies alone are not enough either way).
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(text) ? { token: text, cookieHeader: '' } : null;
}

/**
 * Flatten the transcript into the single `prompt` string the web API takes, in the `Role: text`
 * shape the reference project uses — the transcript guard in `deepseekWebTools` matches exactly
 * these labels, so the model echoing `\nUser:` gets cut instead of reaching the chat.
 *
 * Tool results are rendered with the same `[Tool result id=…]` placeholder the guard looks for;
 * assistant tool calls are replayed as one JSON line per call so the model sees what it did.
 *
 * The cap keeps the TAIL (the newest turns carry the intent) and is computed in characters from a
 * token budget: BPE gives ~4 chars/token for latin but ~1.5 for CJK, so a fixed char ceiling either
 * wastes the window or overruns it ("Content is too long"). The system line is outside the cap —
 * dropping it changes the persona, not just the history.
 */
export function buildDeepSeekPrompt(messages: readonly LlmMessage[], tools: readonly ToolSchema[] = [], opts: { maxChars?: number } = {}): string {
  const render = (message: LlmMessage): string => {
    if (message.role === 'tool') {
      return `[Tool result id=${message.toolCallId ?? 'unknown'}]\n${message.content}`;
    }
    const label = message.role === 'assistant' ? 'Assistant' : 'User';
    const calls = (message.toolCalls ?? [])
      .map((call) => `[tool_call] {"name":${JSON.stringify(call.name)},"arguments":${JSON.stringify(call.args ?? {})}}`)
      .join('\n');
    const content = message.content.trim();
    return calls === '' ? `${label}: ${content}` : `${label}: ${content}${content === '' ? '' : '\n'}${calls}`;
  };

  const systems: string[] = [];
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const content = message.content.trim();
      if (content !== '') systems.push(content);
      continue;
    }
    const rendered = render(message);
    if (rendered.trim() !== '') parts.push(rendered);
  }
  // The tools protocol takes the system slot when tools are present; the language guard only
  // matters when there is nothing stronger to say first.
  systems.push(tools.length > 0 ? buildToolsSystemPrompt(tools) : LANGUAGE_GUARD);

  const maxChars = opts.maxChars ?? charBudgetForTokens(messages, MAX_PROMPT_TOKENS);
  const kept = keepNewest(parts, maxChars, { reserved: '\n\nAssistant:'.length, join: 2 });
  kept.unshift(`System: ${systems.join('\n\n')}`);
  return [...kept, 'Assistant:'].join('\n\n');
}

/** Rough but honest token count: `length / 4` badly underestimates non-latin text. */
function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii += 1;
  }
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}

/**
 * Characters that fit into `maxTokens` for THIS conversation: the exchange rate between characters
 * and tokens is a property of the text, so it is measured rather than assumed.
 */
function charBudgetForTokens(messages: readonly LlmMessage[], maxTokens: number): number {
  let chars = 0;
  let tokens = 0;
  for (const message of messages) {
    if (message.role === 'system') continue;
    chars += message.content.length;
    tokens += estimateTokens(message.content);
  }
  // Nothing to measure yet — assume latin, the cheaper of the two.
  if (tokens === 0) return maxTokens * 4;
  return Math.floor(maxTokens * (chars / tokens));
}

/** Drops the oldest turns until the prompt fits; truncates a lone huge turn. */
function keepNewest(
  parts: readonly string[],
  maxChars: number,
  frame: { reserved: number; join: number },
): string[] {
  const kept: string[] = [];
  let total = frame.reserved;

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const addition = (parts[i]?.length ?? 0) + (kept.length > 0 ? frame.join : 0);
    if (total + addition > maxChars) {
      if (kept.length === 0) {
        const available = Math.max(128, maxChars - total);
        kept.unshift((parts[i] ?? '').slice(-available));
      }
      break;
    }
    kept.unshift(parts[i] ?? '');
    total += addition;
  }

  return kept;
}

/** Standard `data:` lines of an SSE body, decoded incrementally. */
async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── x-client-version: follow the live web bundle ───────────────────────────

const MAIN_BUNDLE = /static\/main\.[0-9a-f]+\.js/;
const APP_VERSION = /appVersion:"(\d+(?:\.\d+)+)"/;

let appVersionValue = FALLBACK_APP_VERSION;
let appVersionCheckedAt = 0;
let appVersionInFlight: Promise<string> | undefined;

export function deepSeekAppVersion(): string {
  return appVersionValue;
}

export function resetDeepSeekAppVersion(): void {
  appVersionValue = FALLBACK_APP_VERSION;
  appVersionCheckedAt = 0;
  appVersionInFlight = undefined;
}

/**
 * Re-read `appVersion` from the live bundle when the cache is older than six hours. Never throws and
 * never delays a request twice in a row: on any failure the previous version stays and the failure
 * still waits out the interval (a slow home page must not slow every turn).
 */
export function refreshDeepSeekAppVersion(cookieHeader: string, fetchImpl: typeof fetch): Promise<string> {
  if (Date.now() - appVersionCheckedAt < 6 * 60 * 60 * 1000) return Promise.resolve(appVersionValue);
  appVersionInFlight ??= readAppVersionBundle(cookieHeader, fetchImpl).finally(() => {
    appVersionInFlight = undefined;
  });
  return appVersionInFlight;
}

async function readAppVersionBundle(cookieHeader: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    // The home page sits behind the AWS WAF: without the session cookies it answers an empty 202.
    const home = await fetchImpl(`${BASE_URL}/`, {
      headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader },
      signal: AbortSignal.timeout(10_000),
    });
    const bundle = MAIN_BUNDLE.exec(await home.text())?.[0];
    if (!bundle) return finishAppVersion();
    const js = await fetchImpl(`https://fe-static.deepseek.com/chat/${bundle}`, { signal: AbortSignal.timeout(10_000) });
    const found = APP_VERSION.exec(await js.text())?.[1];
    if (!found) return finishAppVersion();
    if (found !== appVersionValue) appVersionValue = found;
    return finishAppVersion();
  } catch {
    return finishAppVersion();
  }
}

function finishAppVersion(): string {
  appVersionCheckedAt = Date.now();
  return appVersionValue;
}

// ─── Proof of work: DeepSeek's own sha3 WASM solver ─────────────────────────

interface DeepSeekWasmExports {
  memory: WebAssembly.Memory;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  __wbindgen_export_0(size: number, align: number): number;
  __wbindgen_export_1(ptr: number, oldSize: number, newSize: number, align: number): number;
  wasm_solve(retptr: number, ptr0: number, len0: number, ptr1: number, len1: number, difficulty: number): void;
}

let wasmSolver: Promise<DeepSeekHash> | undefined;
let wasmSolverUrl = '';

/**
 * Port of DeepSeek's wasm-bindgen glue for the sha3 PoW challenge (from the reference project): the
 * browser loads `sha3_wasm_bg.<hash>.wasm` and calls `wasm_solve(challenge, salt_expireAt_, difficulty)`,
 * which returns an integer answer through the return pointer. Loading it here keeps the answer
 * byte-exact with what the web client produces — a hand-rolled hash would guess the algorithm.
 */
class DeepSeekHash {
  private offset = 0;
  private cachedMemory: Uint8Array | null = null;
  private readonly encoder = new TextEncoder();

  private constructor(private readonly wasm: DeepSeekWasmExports) {}

  static async load(wasmUrl: string, fetchImpl: typeof fetch): Promise<DeepSeekHash> {
    const response = await fetchImpl(wasmUrl);
    if (!response.ok) throw new Error(`Failed to load PoW WASM: HTTP ${response.status}`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), { wbg: {} });
    return new DeepSeekHash(instance.exports as unknown as DeepSeekWasmExports);
  }

  calculateHash(challenge: string, salt: string, difficulty: number, expireAt: number): number | undefined {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const ptr0 = this.encodeString(challenge);
      const len0 = this.offset;
      const ptr1 = this.encodeString(`${salt}_${expireAt}_`);
      const len1 = this.offset;
      this.wasm.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);
      const view = new DataView(this.wasm.memory.buffer);
      const status = view.getInt32(retptr, true);
      return status === 0 ? undefined : view.getFloat64(retptr + 8, true);
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  private memory(): Uint8Array {
    if (!this.cachedMemory || this.cachedMemory.byteLength === 0) {
      this.cachedMemory = new Uint8Array(this.wasm.memory.buffer);
    }
    return this.cachedMemory;
  }

  private encodeString(text: string): number {
    const strLength = text.length;
    let ptr = this.wasm.__wbindgen_export_0(strLength, 1) >>> 0;
    const memory = this.memory();
    let written = 0;
    for (; written < strLength; written += 1) {
      const charCode = text.charCodeAt(written);
      if (charCode > 127) break;
      memory[ptr + written] = charCode;
    }
    if (written !== strLength) {
      const tail = written > 0 ? text.slice(written) : text;
      const capacity = written + tail.length * 3;
      ptr = this.wasm.__wbindgen_export_1(ptr, strLength, capacity, 1) >>> 0;
      const result = this.encoder.encodeInto(tail, this.memory().subarray(ptr + written, ptr + capacity));
      written += result.written;
      ptr = this.wasm.__wbindgen_export_1(ptr, capacity, written, 1) >>> 0;
    }
    this.offset = written;
    return ptr;
  }
}

function getWasmSolver(wasmUrl: string, fetchImpl: typeof fetch): Promise<DeepSeekHash> {
  if (wasmSolver === undefined || wasmSolverUrl !== wasmUrl) {
    wasmSolverUrl = wasmUrl;
    wasmSolver = DeepSeekHash.load(wasmUrl, fetchImpl);
  }
  return wasmSolver;
}

// ─── Delta extraction: the JSON patch stream ────────────────────────────────

const CONTENT_PATH_RE = /\/(content|text|answer)$/i;
const THINKING_PATH_RE = /\/(reasoning_content|reasoning|thinking|thinking_content|reasoning_text)$/i;
/** `response/fragments/<N>/content`, where N may be negative (-1 = last). */
const FRAGMENT_PATH_RE = /\/fragments\/(-?\d+)\/content$/i;
const THINK_TYPE_RE = /^(think|reason|reasoning|cot|thinking)$/i;
const THINKING_FIELD_RE = /^(reasoning|reasoning_content|reasoning_text|thinking|thinking_content|thought|thoughts|cot)$/i;
const CONTENT_CARRIER_TYPES = ['response', 'template_response', 'answer', 'assistant', 'text', 'message'];

/** Target of a content patch: the answer channel or the reasoning channel. */
type PatchTarget = 'text' | 'thinking';

interface PatchState {
  /** Abbreviated tail patches (`{"v":"e"}`) continue the previous APPEND's channel. */
  lastTarget: PatchTarget;
  /** Fragment type by creation order — `response/fragments/<N>/content` carries no marker itself. */
  fragmentTargets: PatchTarget[];
}

export interface ExtractedDelta {
  text: string;
  thinking: string;
  messageId: number | null;
}

/**
 * Walk a DeepSeek SSE payload and pull out the NEW text / reasoning. The format is a patch stream
 * (`{p, o, v}`) mixed with plain snapshots, so `cache` stores what was already emitted per path and
 * only the delta is returned. Ported from the reference project's measured behaviour:
 *
 *  - `{"p":"response/content","o":"APPEND","v":"H"}` then bare `{"v":"e"}` tails that inherit the
 *    previous channel;
 *  - `response/fragments` APPEND registers THINK/RESPONSE fragments whose content patches resolve by
 *    index (negative = from the end) — getting this wrong leaks the reasoning into the answer;
 *  - `BATCH` wraps several patches in one event;
 *  - plain snapshot objects (`{content, type: 'response'}`, `{delta: {…}}`, OpenAI-ish `choices`)
 *    carry the whole text so far, hence the per-path cache.
 */
export function extractDelta(
  value: unknown,
  cache: Map<string, string>,
  state: PatchState,
): ExtractedDelta {
  let messageId: number | null = null;
  let text = '';
  let thinking = '';

  const append = (target: PatchTarget, delta: string): void => {
    if (target === 'thinking') thinking += delta;
    else text += delta;
  };

  /** Emits only what is new compared to the previous snapshot of this key. */
  const appendSnapshot = (key: string, current: string, target: PatchTarget): void => {
    const previous = cache.get(key) ?? '';
    const delta = current.startsWith(previous) ? current.slice(previous.length) : current;
    cache.set(key, current);
    if (delta !== '') append(target, delta);
  };

  const targetForPath = (path: string): PatchTarget | undefined => {
    const fragment = FRAGMENT_PATH_RE.exec(path);
    if (fragment) {
      const raw = Number(fragment[1]);
      const list = state.fragmentTargets;
      // Fragment type not registered yet — fall back to the active target.
      return list[raw < 0 ? list.length + raw : raw] ?? state.lastTarget;
    }
    if (THINKING_PATH_RE.test(path)) return 'thinking';
    if (CONTENT_PATH_RE.test(path)) return 'text';
    return undefined;
  };

  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    for (const raw of [obj.response_message_id, obj.message_id]) {
      const id = toFiniteNumber(raw);
      if (id !== null) messageId = id;
    }
    const role = typeof obj.role === 'string' ? obj.role.toLowerCase() : '';
    if (role === 'assistant') {
      const id = toFiniteNumber(obj.id);
      if (id !== null) messageId = id;
    }

    // The opening snapshot already lists fragments — with reasoning on, the first is a THINK one.
    // Its type must be registered like an appended fragment's: the `response/fragments/-1/content`
    // patches that follow resolve against this list, and an empty one made the whole reasoning leak
    // into the answer.
    if (Array.isArray(obj.fragments)) {
      state.fragmentTargets = obj.fragments.map((fragment) =>
        THINK_TYPE_RE.test(String((fragment as { type?: unknown } | null)?.type ?? '')) ? 'thinking' : 'text');
      const last = state.fragmentTargets[state.fragmentTargets.length - 1];
      if (last !== undefined) state.lastTarget = last;
    }

    // Abbreviated patch `{"v":"…"}` with no path: continues the previous APPEND. Happens at any
    // depth (inside BATCH too), hence no path check.
    if (Object.keys(obj).length === 1 && typeof obj.v === 'string') {
      append(state.lastTarget, obj.v);
      return;
    }

    // Fragment registration comes before the APPEND branch so the target of the content that
    // follows is already known.
    if (obj.o === 'APPEND' && obj.p === 'response/fragments' && Array.isArray(obj.v)) {
      obj.v.forEach((fragment, index) => {
        if (!fragment || typeof fragment !== 'object') return;
        const frag = fragment as Record<string, unknown>;
        const target: PatchTarget = THINK_TYPE_RE.test(typeof frag.type === 'string' ? frag.type : '') ? 'thinking' : 'text';
        state.fragmentTargets.push(target);
        state.lastTarget = target;
        if (typeof frag.content === 'string' && frag.content !== '') {
          const id = frag.id === undefined ? `idx-${index}` : String(frag.id);
          appendSnapshot(`${messageId ?? 'unknown'}:${path}:fragment:${id}:content`, frag.content, target);
        }
      });
      return;
    }

    if (obj.o === 'BATCH' && Array.isArray(obj.v)) {
      obj.v.forEach((item, index) => visit(item, `${path}.v.${index}`));
      return;
    }

    // Path patches. `o` may be missing entirely — then it inherits the previous operation, an append.
    if (typeof obj.p === 'string' && typeof obj.v === 'string') {
      const target = targetForPath(obj.p);
      if (target !== undefined) {
        state.lastTarget = target;
        if (typeof obj.o === 'string' && obj.o !== 'APPEND') {
          appendSnapshot(`${messageId ?? 'unknown'}:${path}:${obj.p}`, obj.v, target);
        } else {
          append(target, obj.v);
        }
        return;
      }
    }

    if (typeof obj.content === 'string' && (typeof obj.type === 'string' || role === 'assistant')) {
      const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
      const phase = typeof obj.phase === 'string' ? obj.phase.toLowerCase() : '';
      const key = `${messageId ?? 'unknown'}:${path}:${type || role || 'content'}`;
      if (THINK_TYPE_RE.test(type) || phase === 'think') {
        appendSnapshot(key, obj.content, 'thinking');
      } else if (CONTENT_CARRIER_TYPES.includes(type) || role === 'assistant') {
        appendSnapshot(key, obj.content, 'text');
      }
    }

    if (typeof obj.text === 'string') {
      appendSnapshot(`${messageId ?? 'unknown'}:${path}:text`, obj.text, 'text');
    }

    if (obj.delta && typeof obj.delta === 'object') {
      const delta = obj.delta as Record<string, unknown>;
      const isThinkPhase = typeof obj.phase === 'string' && obj.phase.toLowerCase() === 'think';
      for (const field of ['content', 'reasoning_content', 'thinking', 'reasoning', 'text', 'answer']) {
        const val = delta[field];
        if (typeof val !== 'string') continue;
        const target: PatchTarget = THINKING_FIELD_RE.test(field) || (field === 'content' && isThinkPhase) ? 'thinking' : 'text';
        appendSnapshot(`${messageId ?? 'unknown'}:${path}:delta:${field}`, val, target);
      }
    }

    const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
    if (choice && typeof choice === 'object') {
      const delta = (choice as { delta?: Record<string, unknown> }).delta ?? {};
      if (typeof delta.content === 'string') text += delta.content;
      if (typeof delta.reasoning_content === 'string') thinking += delta.reasoning_content;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }

    // `content`, `choices` and `delta` are fully handled above; descending into them again would
    // emit the same reasoning text a second time.
    for (const [key, item] of Object.entries(obj)) {
      if (key === 'content' || key === 'choices' || key === 'delta') continue;
      if (typeof item === 'string' && THINKING_FIELD_RE.test(key)) {
        appendSnapshot(`${messageId ?? 'unknown'}:${path}:field:${key}`, item, 'thinking');
        continue;
      }
      visit(item, `${path}.${key}`);
    }
  };

  visit(value, '$');
  return { text, thinking, messageId };
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// ─── The adapter ────────────────────────────────────────────────────────────

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** In-stream failure frame, e.g. the one-generation-per-account limit. */
function bizErrorOf(parsed: unknown): string | null {
  const data = parsed as {
    type?: unknown; content?: unknown; finish_reason?: unknown;
    biz_code?: unknown; biz_msg?: unknown;
    data?: { biz_code?: unknown; biz_msg?: unknown };
  } | null;
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'error' && typeof data.content === 'string') {
    return data.finish_reason === undefined ? data.content : `${data.content} (${String(data.finish_reason)})`;
  }
  const code = data.data?.biz_code ?? data.biz_code;
  if (typeof code === 'number' && code !== 0) {
    const msg = data.data?.biz_msg ?? data.biz_msg;
    return `DeepSeek biz error ${code}: ${typeof msg === 'string' ? msg : 'Unknown error'}`;
  }
  return null;
}

/** Backoff before re-entering the single generation slot. */
const PARALLEL_LIMIT_RETRY_DELAYS_MS = [1500, 4000];

/**
 * Backoff for the account-wide throttle ("Messages too frequent"). It counts turns over a window
 * rather than concurrency, so it needs a real pause — the sub-second backoff a busy generation slot
 * gets would just burn the retries.
 */
const RATE_LIMIT_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

/**
 * After a throttle, turns are spaced out for a while so the next burst does not run straight back
 * into it. Before one, requests go at full speed.
 */
const THROTTLED_MIN_INTERVAL_MS = 6000;
const THROTTLED_PACING_MS = 5 * 60_000;

/** Backoff after a dropped connection. Prompts here are ~100 KB, so retries are not free — two
 *  attempts, then give the error to the user. */
const NETWORK_RETRY_DELAYS_MS = [1000, 3000];

/** Where the Expert model falls back to when the upstream is overloaded. */
const DEFAULT_MODEL_ID = 'deepseek-web';

/**
 * How much text one upstream session may accumulate before it is abandoned.
 *
 * The whole conversation is resent as a single prompt on every turn, so a session that chains its
 * messages holds that history once per turn and runs into DeepSeek's "Length limit reached. Please
 * start a new chat." after a few of them. Rolling over to a new session beforehand keeps that
 * failure out of the chat; nothing is lost, because the prompt carries the history anyway.
 */
const SESSION_CONTEXT_BUDGET_TOKENS = MAX_PROMPT_TOKENS;

/**
 * Prompt budgets for the retries after the upstream reported a length limit, as a share of what it
 * just refused. The window depends on the account and the language, so it is found by halving
 * rather than assumed. Floor below: a turn carrying too little is not useful.
 */
const SHRUNK_PROMPT_FRACTIONS = [0.5, 0.25, 0.12];
const MIN_PROMPT_CHARS = 20_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One retry of the request: where to send it and with which model. */
interface Attempt {
  sessionId: string;
  parentId?: number;
  model?: string;
  maxPromptChars?: number;
}

/** The upstream session a conversation chains onto, and how much it already holds. */
interface ConversationSession {
  sessionId: string;
  parentMessageId?: number;
  /** Text already pushed into the session, prompts plus answers. */
  usedChars: number;
  /** Prompt budget a length-limited conversation was last accepted at. */
  promptCap?: number;
}

/**
 * Stable key for the upstream chat/session cache: same model + same opening user message means the
 * same conversation (the reference project's `conversationKey`).
 */
function conversationKeyOf(request: LlmRequest): string {
  const first = request.messages.find((message) => message.role === 'user');
  const basis = `${request.model}::${(first?.content ?? '').slice(0, 600)}`;

  let hash = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Roughly what the prompt will weigh for this request, capped by a known-good budget. */
function estimatePromptChars(request: LlmRequest, cap?: number): number {
  let total = 0;
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    total += message.content.length;
  }
  return Math.min(total, cap ?? charBudgetForTokens(request.messages, MAX_PROMPT_TOKENS));
}

/** One generation per ACCOUNT, not per session: another request is still being answered. */
function isParallelLimit(error: unknown): boolean {
  return error instanceof Error && /parallel_chat_limit|message is being generated/i.test(error.message);
}

/** The account sent too many turns too quickly — reported inside the stream, not as HTTP 429. */
function isRateLimited(error: unknown): boolean {
  return error instanceof Error && /rate_limit_reached|messages too frequent|too many requests/i.test(error.message);
}

/** The server is still generating the previous answer in this session. */
function isSessionBusy(error: unknown): boolean {
  return error instanceof Error && /biz error\s*11|message still wip/i.test(error.message);
}

/** parent_message_id points at a message the session no longer knows. */
function isStaleParent(error: unknown): boolean {
  return error instanceof Error && /biz error\s*26|invalid message id/i.test(error.message);
}

/** The session id is not one the account has: deleted from the DeepSeek UI, or dropped upstream. */
function isUnknownSession(error: unknown): boolean {
  return error instanceof Error && /invalid chat session|chat session (?:not found|does not exist)|biz error\s*1\b/i.test(error.message);
}

/** The turn does not fit — a session that ran out of room, or a single prompt over the window. */
function isContextLimit(error: unknown): boolean {
  return error instanceof Error && /context_length_exceeded|input_exceeds_limit|length limit reached|content is too long|start a new chat/i.test(error.message);
}

/** The Expert model itself is overloaded; the upstream suggests the default one. */
function isExpertBusy(error: unknown): boolean {
  return error instanceof Error && /expert_busy_use_default/i.test(error.message);
}

/** A dropped connection — common enough on the free web backend that one must not surface. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && /fetch failed|terminated|socket hang up|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR/i.test(error.message);
}

function isRecoverable(error: unknown): boolean {
  return (
    isSessionBusy(error) ||
    isStaleParent(error) ||
    isParallelLimit(error) ||
    isRateLimited(error) ||
    isExpertBusy(error) ||
    isUnknownSession(error) ||
    isContextLimit(error) ||
    isNetworkFailure(error)
  );
}

/**
 * A non-SSE completion answer: DeepSeek reports auth expiry, account mutes and throttles as JSON
 * with HTTP 200. Parsed into something a user can act on instead of raw JSON.
 */
function completionError(status: number, text: string): Error {
  let message = `HTTP ${status}: ${text.slice(0, 220)}`;
  try {
    const parsed = JSON.parse(text) as { code?: number; msg?: string; data?: { biz_code?: number; biz_msg?: string } };
    if (parsed.code === 40002 || parsed.code === 40003) return new DeepSeekAuthExpiredError();
    if (typeof parsed.data?.biz_code === 'number') {
      message = `DeepSeek biz error ${parsed.data.biz_code}: ${parsed.data.biz_msg ?? ''}`;
    } else if (parsed.msg) {
      message = parsed.msg;
    }
  } catch {
    /* not JSON — keep the raw message */
  }
  return new Error(message);
}

export class DeepSeekWebAdapter implements ProviderAdapter {
  readonly id = DEEPSEEK_WEB_PROVIDER_ID;
  readonly name = 'DeepSeek Web (chat.deepseek.com)';
  private auth: DeepSeekAuth | null = null;
  /** DeepSeek allows one generation per account: requests are serialized behind a single slot. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private paceUntil = 0;
  /** Reused upstream session per conversation — a fresh session per turn is bot-shaped traffic. */
  private readonly sessionByConversation = new Map<string, ConversationSession>();

  constructor(private readonly options: DeepSeekWebOptions = {}) {}

  setApiKey(raw: string): void {
    this.auth = parseDeepSeekCredential(raw);
  }

  async listModels(): Promise<ModelInfo[]> {
    // Only signed-in models appear — no dead entries that fail on use.
    return this.auth !== null && this.auth.cookieHeader.includes('ds_session_id') ? MODELS : [];
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamEvent> {
    const auth = this.auth;
    if (auth === null || !auth.cookieHeader.includes('ds_session_id')) {
      yield {
        type: 'error',
        error: {
          code: 'NO_CREDENTIAL',
          message: 'DeepSeek Web cần thông tin đăng nhập: JSON {"token","cookieHeader"} với cookie ds_session_id từ chat.deepseek.com.',
          retryable: false,
        },
      };
      yield { type: 'finish', reason: 'error' };
      return;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch.bind(globalThis);
    // The wait can outlive the request that was queued; the abort check below catches that.
    const release = await this.acquireSlot();
    try {
      if (request.signal.aborted) {
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      yield* this.streamInSlot(request, auth, fetchImpl);
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      const expired = error instanceof DeepSeekAuthExpiredError;
      yield {
        type: 'error',
        error: { code: expired ? 'AUTH_EXPIRED' : 'stream_error', message: error instanceof Error ? error.message : String(error), retryable: !expired },
      };
      yield { type: 'finish', reason: 'error' };
    } finally {
      release();
    }
  }

  /** One request with its recovery ladder, inside the account's single generation slot. */
  private async *streamInSlot(
    request: LlmRequest,
    auth: DeepSeekAuth,
    fetchImpl: typeof fetch,
  ): AsyncGenerator<StreamEvent> {
    const key = conversationKeyOf(request);
    const entry = this.sessionByConversation.get(key);
    let sessionId = entry?.sessionId;
    let parentMessageId = entry?.parentMessageId;
    const promptCap = entry?.promptCap;
    const promptChars = estimatePromptChars(request, promptCap);

    // A session that chains its turns accumulates the history server-side and eventually answers
    // "Length limit reached". Roll over BEFORE that: the prompt carries the history anyway.
    const sessionBudget = charBudgetForTokens(request.messages, SESSION_CONTEXT_BUDGET_TOKENS);
    if (sessionId !== undefined && (entry?.usedChars ?? 0) + promptChars > sessionBudget) {
      sessionId = undefined;
    }

    if (sessionId === undefined) {
      sessionId = await this.createSessionWithRetry(auth, request.signal, fetchImpl);
      this.sessionByConversation.set(key, { sessionId, usedChars: 0 });
      parentMessageId = undefined;
    }

    // Anything already shown to the user makes a retry unsafe: the answer would stream twice.
    const ctx = { streamedToUser: false };

    const waitAndRetry = (ms: number, reason: string) => async (): Promise<Attempt> => {
      await delay(ms);
      return { sessionId, parentId: parentMessageId, maxPromptChars: promptCap };
    };
    const useDefaultModel = async (): Promise<Attempt> => ({
      sessionId,
      parentId: parentMessageId,
      model: DEFAULT_MODEL_ID,
      maxPromptChars: promptCap,
    });
    const withoutParent = async (): Promise<Attempt> => {
      const current = this.sessionByConversation.get(key);
      if (current) this.sessionByConversation.set(key, { ...current, parentMessageId: undefined });
      return { sessionId, maxPromptChars: promptCap };
    };
    const freshSession = async (): Promise<Attempt> => {
      const fresh = await this.createSessionWithRetry(auth, request.signal, fetchImpl);
      this.sessionByConversation.set(key, { sessionId: fresh, usedChars: 0 });
      return { sessionId: fresh, maxPromptChars: promptCap };
    };
    const shrinkPrompt = (chars: number) => async (): Promise<Attempt> => ({
      sessionId: this.sessionByConversation.get(key)?.sessionId ?? sessionId,
      maxPromptChars: chars,
    });

    const stepsFor = (error: unknown): Array<() => Promise<Attempt>> => {
      // Checked before the slot limit: both mean "come back later", but only this one is counted
      // per account over a window rather than per request.
      if (isRateLimited(error)) {
        this.paceUntil = Date.now() + THROTTLED_PACING_MS;
        return (this.options.retryDelays?.rateLimit ?? RATE_LIMIT_RETRY_DELAYS_MS).map((ms, i) =>
          i === 0 ? waitAndRetry(ms, 'rate limited') : waitAndRetry(ms, 'rate limited'),
        );
      }
      if (isParallelLimit(error)) {
        return (this.options.retryDelays?.parallelLimit ?? PARALLEL_LIMIT_RETRY_DELAYS_MS).map((ms) =>
          waitAndRetry(ms, 'generation slot busy'),
        );
      }
      if (isNetworkFailure(error)) {
        return (this.options.retryDelays?.network ?? NETWORK_RETRY_DELAYS_MS).map((ms) =>
          waitAndRetry(ms, 'connection failed'),
        );
      }
      if (isExpertBusy(error)) return [useDefaultModel];
      if (isSessionBusy(error)) return [freshSession];
      if (isUnknownSession(error)) return [freshSession];
      if (isContextLimit(error)) {
        // Halve down from what was actually sent: a budget at or above the refused size would
        // resend the very same prompt and burn a retry on a certain failure.
        const refused = estimatePromptChars(request, promptCap);
        const budgets = [
          ...new Set(
            SHRUNK_PROMPT_FRACTIONS
              .map((share) => Math.max(MIN_PROMPT_CHARS, Math.floor(refused * share)))
              .filter((chars) => chars < refused),
          ),
        ];
        const shrinks = budgets.map((chars) => shrinkPrompt(chars));
        return (entry?.usedChars ?? 0) > 0 ? [freshSession, ...shrinks] : shrinks;
      }
      return [withoutParent, freshSession];
    };

    let lastError: unknown;
    try {
      yield* this.attemptStream(request, auth, fetchImpl, key, ctx, {
        sessionId,
        parentId: parentMessageId,
        maxPromptChars: promptCap,
      });
      return;
    } catch (error) {
      lastError = error;
    }

    for (const step of stepsFor(lastError)) {
      if (!isRecoverable(lastError) || ctx.streamedToUser || request.signal.aborted) break;
      try {
        const attempt = await step();
        yield* this.attemptStream(request, auth, fetchImpl, key, ctx, {
          ...attempt,
          maxPromptChars: attempt.maxPromptChars ?? promptCap,
        });
        return;
      } catch (retryError) {
        lastError = retryError;
      }
    }

    throw lastError;
  }

  /** One completion attempt: PoW, the SSE patch stream, the tool-call router, session bookkeeping. */
  private async *attemptStream(
    request: LlmRequest,
    auth: DeepSeekAuth,
    fetchImpl: typeof fetch,
    key: string,
    ctx: { streamedToUser: boolean },
    attempt: Attempt,
  ): AsyncGenerator<StreamEvent> {
    await this.pace(request.signal);
    let messageId: number | undefined;
    try {
      const prompt = buildDeepSeekPrompt(request.messages, request.tools, { maxChars: attempt.maxPromptChars });
      const modelType = attempt.model === 'deepseek-web-expert' || (attempt.model === undefined && request.model === 'deepseek-web-expert') ? 'expert' : 'default';
      // Thinking stays off whenever tools are in play: reasoning + tool calls is unreliable on the
      // web backend — the call leaks into the reasoning channel and never reaches the router.
      const thinkingEnabled = modelType === 'expert' && request.tools.length === 0;
      // The web API has no tool channel: when tools are present the router watches the text for the
      // protocol the system prompt asked for, and the raw markers never reach the client.
      const router = new StreamingToolCallRouter(request.tools.length > 0);
      let sawToolCall = false;
      let produced = false;
      let answerChars = 0;
      let stoppedUpstream = false;

      const powHeader = await this.powHeader(auth, COMPLETION_PATH, fetchImpl);
      const response = await fetchImpl(`${BASE_URL}${COMPLETION_PATH}`, {
        method: 'POST',
        headers: { ...this.buildHeaders(auth), 'X-DS-PoW-Response': powHeader },
        body: JSON.stringify({
          chat_session_id: attempt.sessionId,
          parent_message_id: attempt.parentId ?? null,
          model_type: modelType,
          preempt: false,
          prompt,
          ref_file_ids: [],
          thinking_enabled: thinkingEnabled,
          search_enabled: false,
        }),
        signal: request.signal,
      });

      const contentType = String(response.headers.get('content-type') ?? '');
      if (!response.ok || !contentType.includes('text/event-stream')) {
        throw completionError(response.status, await response.text().catch(() => ''));
      }
      if (!response.body) throw new Error('Response body is empty');

      const cache = new Map<string, string>();
      const state: PatchState = { lastTarget: 'text', fragmentTargets: [] };
      for await (const data of sseData(response.body, request.signal)) {
        if (request.signal.aborted) break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        // In-stream failure frames (throttle, slot limit) throw so the recovery ladder can react.
        const biz = bizErrorOf(parsed);
        if (biz !== null) throw new Error(biz);
        const delta = extractDelta(parsed, cache, state);
        if (delta.messageId !== null) messageId = delta.messageId;
        if (delta.thinking !== '') {
          answerChars += delta.thinking.length;
          yield { type: 'reasoning_delta', text: delta.thinking };
        }
        if (delta.text === '') continue;
        for (const chunk of router.route(delta.text)) {
          if (chunk.type === 'text') {
            produced = true;
            ctx.streamedToUser = true;
            answerChars += chunk.content.length;
          }
          if (chunk.type === 'tool_call') {
            produced = true;
            ctx.streamedToUser = true;
            sawToolCall = true;
          }
          yield* mapToolCallChunk(chunk);
        }
        // The router saw the model playing out the transcript — a fabricated next turn. Stop the
        // upstream so it stops burning tokens; the rest of the answer is already discarded.
        if (router.cut && !stoppedUpstream) {
          stoppedUpstream = true;
          await this.stopStream(auth, attempt.sessionId, messageId, fetchImpl).catch(() => undefined);
        }
      }
      if (request.signal.aborted) {
        // The loop breaks on abort before the fetch body notices — the same server-side stop is
        // needed here as in the catch below: a "wip" message would poison the session.
        await this.stopStream(auth, attempt.sessionId, messageId, fetchImpl).catch(() => undefined);
        throw Object.assign(new Error('DeepSeek stream aborted'), { name: 'AbortError' });
      }
      for (const chunk of router.finish()) {
        if (chunk.type === 'text') {
          produced = true;
          ctx.streamedToUser = true;
          answerChars += chunk.content.length;
        }
        if (chunk.type === 'tool_call') {
          produced = true;
          ctx.streamedToUser = true;
          sawToolCall = true;
        }
        yield* mapToolCallChunk(chunk);
      }

      // Chain onto this message only if the turn actually said something: an empty answer leaves an
      // id the session does not accept back ("invalid message id" on the next turn).
      const current = this.sessionByConversation.get(key);
      if (current) {
        this.sessionByConversation.set(key, {
          ...current,
          sessionId: attempt.sessionId,
          parentMessageId: produced && messageId !== undefined ? messageId : undefined,
          usedChars: current.usedChars + estimatePromptChars(request, attempt.maxPromptChars) + answerChars,
          promptCap: attempt.maxPromptChars !== undefined ? attempt.maxPromptChars : current.promptCap,
        });
      }
      yield { type: 'finish', reason: sawToolCall ? 'tool_calls' : 'stop' };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        // A plain disconnect leaves the message "wip" and the session refuses the next request, so
        // the generation is stopped server-side before the stream is abandoned.
        await this.stopStream(auth, attempt.sessionId, messageId, fetchImpl).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Serializes requests: DeepSeek allows one generation per account, not per session. */
  private async acquireSlot(): Promise<() => void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    return release;
  }

  /** Spaces requests out while the account was recently throttled. */
  private async pace(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    if (now < this.paceUntil) {
      const wait = this.lastRequestAt + THROTTLED_MIN_INTERVAL_MS - now;
      if (wait > 0 && !signal.aborted) await delay(wait);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Session creation happens before the streaming recovery ladder can help, so it carries its own
   * retry: the TLS handshake to chat.deepseek.com gets reset often enough that a single failure
   * must not surface as a chat error.
   */
  private async createSessionWithRetry(auth: DeepSeekAuth, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
    const delays = this.options.retryDelays?.network ?? NETWORK_RETRY_DELAYS_MS;
    let lastError: unknown = undefined;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await delay(delays[attempt - 1] ?? 0);
      try {
        const session = await this.requestJson(CREATE_SESSION_PATH, auth, {}, signal, fetchImpl);
        const id = session.data?.biz_data?.id ?? session.data?.biz_data?.chat_session?.id;
        if (id === undefined) {
          throw new Error(`Failed to get DeepSeek session id: ${JSON.stringify(session).slice(0, 250)}`);
        }
        return id;
      } catch (error) {
        lastError = error;
        if (!isNetworkFailure(error) || signal.aborted) throw error;
      }
    }
    throw lastError;
  }

  /** Maps a routed chunk onto the stream events the loop understands. */
  // Placed as a free function below the class instead — see mapToolCallChunk.

  /** `chat/stop_stream` — best-effort; failures are swallowed by the callers. */
  private async stopStream(auth: DeepSeekAuth, sessionId: string, messageId: number | undefined, fetchImpl: typeof fetch): Promise<void> {
    await this.requestJson(
      STOP_STREAM_PATH,
      auth,
      { chat_session_id: sessionId, ...(messageId === undefined ? {} : { message_id: messageId }) },
      undefined,
      fetchImpl,
    );
  }

  private async powHeader(auth: DeepSeekAuth, targetPath: string, fetchImpl: typeof fetch): Promise<string> {
    const json = await this.requestJson(CREATE_POW_PATH, auth, { target_path: targetPath }, undefined, fetchImpl);
    const challenge = json.data?.biz_data?.challenge;
    if (challenge === undefined) {
      throw new Error(`PoW challenge not received: ${JSON.stringify(json).slice(0, 220)}`);
    }
    if (challenge.algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}`);
    }
    const expireAt = challenge.expire_at ?? challenge.expireAt;
    if (!Number.isFinite(expireAt)) throw new Error('PoW challenge without expire_at');

    // The injected solver is the test seam; production loads DeepSeek's own WASM.
    const answer = this.options.solver !== undefined
      ? this.options.solver(challenge.challenge, challenge.salt, Number(challenge.difficulty), Number(expireAt))
      : (await getWasmSolver(this.options.wasmUrl ?? DEFAULT_WASM_URL, fetchImpl))
        .calculateHash(challenge.challenge, challenge.salt, Number(challenge.difficulty), Number(expireAt));
    if (!Number.isInteger(answer)) throw new Error('PoW solver returned an invalid answer');

    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: targetPath,
      }),
      'utf8',
    ).toString('base64');
  }

  private async requestJson(
    path: string,
    auth: DeepSeekAuth,
    body: unknown,
    signal: AbortSignal | undefined,
    fetchImpl: typeof fetch,
  ): Promise<DeepSeekJson> {
    await refreshDeepSeekAppVersion(auth.cookieHeader, fetchImpl);
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: this.buildHeaders(auth),
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text().catch(() => '');
    let json: DeepSeekJson;
    try {
      json = JSON.parse(text) as DeepSeekJson;
    } catch {
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 220)}`);
      throw new Error(`Invalid JSON from DeepSeek (${path}), status=${response.status}`);
    }
    if ([json.code, json.data?.code].some((code) => code === 40002 || code === 40003)) {
      throw new DeepSeekAuthExpiredError();
    }
    const bizCode = json.data?.biz_code;
    if (typeof bizCode === 'number' && bizCode !== 0) {
      throw new Error(`DeepSeek biz error ${bizCode}: ${json.data?.biz_msg ?? ''}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 220)}`);
    return json;
  }

  private buildHeaders(auth: DeepSeekAuth): Record<string, string> {
    const version = deepSeekAppVersion();
    return {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      Cookie: auth.cookieHeader,
      'X-App-Version': version,
      'x-client-platform': 'web',
      'x-client-version': version,
      'x-client-locale': 'en',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      // Cookies alone are not enough: without the Bearer the API answers 40002.
      ...(auth.token === undefined ? {} : { Authorization: `Bearer ${auth.token}` }),
    };
  }
}

/** Maps a routed chunk onto the stream events the loop understands. */
function* mapToolCallChunk(chunk: ToolCallChunk): Generator<StreamEvent> {
  if (chunk.type === 'text') {
    if (chunk.content !== '') yield { type: 'text_delta', text: chunk.content };
    return;
  }
  yield { type: 'tool_call_start', callId: chunk.callId, name: chunk.name };
  yield { type: 'tool_call_delta', callId: chunk.callId, argsDelta: chunk.argumentsPart };
  // Unparsable argument JSON still reaches the tool loop as an empty object — the loop's
  // validation reports the missing parameters back to the model, which can retry.
  let args: unknown = {};
  try {
    args = JSON.parse(chunk.argumentsPart) as unknown;
  } catch {
    /* keep {} */
  }
  yield { type: 'tool_call_end', callId: chunk.callId, name: chunk.name, args };
}
