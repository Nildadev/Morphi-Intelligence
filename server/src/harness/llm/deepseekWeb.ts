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
/** ~75k tokens at ~4 chars/token — the reference project's budget for the 128k window. */
const MAX_PROMPT_CHARS = 300_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export const DEEPSEEK_WEB_PROVIDER_ID = 'deepseek-web';

const MODELS: ModelInfo[] = [
  { id: 'deepseek-web', name: 'DeepSeek Web', provider: DEEPSEEK_WEB_PROVIDER_ID, providerLabel: 'DeepSeek Web', context: 131_072, supportsTools: false },
  // `expert` is the web client's stronger mode; it maps to `thinking_enabled: true` on the wire.
  { id: 'deepseek-web-expert', name: 'DeepSeek Web Expert (DeepThink)', provider: DEEPSEEK_WEB_PROVIDER_ID, providerLabel: 'DeepSeek Web', context: 131_072, supportsTools: false },
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
 * Flatten the transcript into the single `prompt` string the web API takes. Role-labelled lines keep
 * the loop's multi-turn shape readable to the model; tool results are labelled too (v1 sends no tool
 * schemas, but the loop still replays past tool results as history).
 *
 * The cap keeps the TAIL (the newest turns carry the intent); the system message survives the cut
 * because dropping it changes the persona, not just the history.
 */
export function buildDeepSeekPrompt(messages: readonly LlmMessage[]): string {
  const render = (message: LlmMessage): string => {
    if (message.role === 'system') return `[System]\n${message.content}`;
    if (message.role === 'user') return `[User]\n${message.content}`;
    if (message.role === 'tool') return `[Tool result${message.toolCallId ? ` ${message.toolCallId}` : ''}]\n${message.content}`;
    return `[Assistant]\n${message.content}`;
  };
  const rendered = messages.map(render);
  const total = rendered.join('\n\n').length;
  if (total <= MAX_PROMPT_CHARS) return rendered.join('\n\n');

  // Keep the system line plus as many trailing messages as fit.
  const kept: string[] = rendered[0] !== undefined && messages[0]?.role === 'system' ? [rendered[0]] : [];
  let used = kept[0]?.length ?? 0;
  for (let index = rendered.length - 1; index >= (messages[0]?.role === 'system' ? 1 : 0); index -= 1) {
    const length = rendered[index]!.length + 2;
    if (used + length > MAX_PROMPT_CHARS) break;
    kept.splice(messages[0]?.role === 'system' ? 1 : 0, 0, rendered[index]!);
    used += length;
  }
  return kept.join('\n\n');
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

export class DeepSeekWebAdapter implements ProviderAdapter {
  readonly id = DEEPSEEK_WEB_PROVIDER_ID;
  readonly name = 'DeepSeek Web (chat.deepseek.com)';
  private auth: DeepSeekAuth | null = null;

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
    let sessionId: string | undefined;
    let messageId: number | undefined;
    try {
      if (request.signal.aborted) {
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      const prompt = buildDeepSeekPrompt(request.messages);
      const modelType = request.model === 'deepseek-web-expert' ? 'expert' : 'default';

      const session = await this.requestJson(CREATE_SESSION_PATH, auth, {}, request.signal, fetchImpl);
      sessionId = session.data?.biz_data?.id ?? session.data?.biz_data?.chat_session?.id;
      if (sessionId === undefined) {
        throw new Error(`Failed to get DeepSeek session id: ${JSON.stringify(session).slice(0, 250)}`);
      }

      const powHeader = await this.powHeader(auth, COMPLETION_PATH, fetchImpl);
      const response = await fetchImpl(`${BASE_URL}${COMPLETION_PATH}`, {
        method: 'POST',
        headers: { ...this.buildHeaders(auth), 'X-DS-PoW-Response': powHeader },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          model_type: modelType,
          preempt: false,
          prompt,
          ref_file_ids: [],
          thinking_enabled: modelType === 'expert',
          search_enabled: false,
        }),
        signal: request.signal,
      });

      const contentType = String(response.headers.get('content-type') ?? '');
      if (!response.ok || !contentType.includes('text/event-stream')) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 220)}`);
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
        const biz = bizErrorOf(parsed);
        if (biz !== null) {
          await this.stopStream(auth, sessionId, messageId, fetchImpl).catch(() => undefined);
          yield { type: 'error', error: { code: 'stream_error', message: biz, retryable: false } };
          yield { type: 'finish', reason: 'error' };
          return;
        }
        const delta = extractDelta(parsed, cache, state);
        if (delta.messageId !== null) messageId = delta.messageId;
        if (delta.thinking !== '') yield { type: 'reasoning_delta', text: delta.thinking };
        if (delta.text !== '') yield { type: 'text_delta', text: delta.text };
      }
      if (request.signal.aborted) {
        // The loop above breaks on abort before the fetch body notices, so the same server-side
        // stop is needed here as in the catch below — a "wip" message would poison the session.
        await this.stopStream(auth, sessionId, messageId, fetchImpl).catch(() => undefined);
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      yield { type: 'finish', reason: 'stop' };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        // A plain disconnect leaves the message "wip" and the session refuses the next request, so
        // the generation is stopped server-side before the stream is abandoned.
        if (sessionId !== undefined) await this.stopStream(auth, sessionId, messageId, fetchImpl).catch(() => undefined);
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      const expired = error instanceof DeepSeekAuthExpiredError;
      yield {
        type: 'error',
        error: { code: expired ? 'AUTH_EXPIRED' : 'stream_error', message: error instanceof Error ? error.message : String(error), retryable: !expired },
      };
      yield { type: 'finish', reason: 'error' };
    }
  }

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
