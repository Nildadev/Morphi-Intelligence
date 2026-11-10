import type { LlmRequest, ModelInfo, ProviderAdapter, StreamEvent } from './types';

/**
 * Task 25 — deterministic LLM seam for Playwright E2E.
 *
 * The adapter is registered ONLY at the composition root (`src/index.ts`) when `MORPHI_FAKE_LLM=1`,
 * together with a fake credential and a `fake`-first auto priority (R25-2/R25-3). It never opens a
 * socket, never reads a real key, and honours `LlmRequest.signal` on every await so the Stop button
 * exercises the real cooperative-cancel path instead of a test-only shortcut.
 *
 * Script selection: a leading `/script <name>` marker in the last user message wins; otherwise
 * `MORPHI_FAKE_SCRIPT` (default `text`) decides. One server can therefore serve every scenario.
 */
export const FAKE_PROVIDER_ID = 'fake';
export const FAKE_TOOL_NAME = 'e2e_echo';

export const FAKE_SCRIPTS = [
  'text', 'tool-then-text', 'missing-key', 'slow', 'cancel', 'regenerate',
  // Task 31C demo scripts: they call the REAL Studio MCP surface through the harness, so the tool
  // card, the approval gate and the result text are produced by production code, not by the fake.
  'studio-state', 'studio-insert',
  // Workspace-change demo: calls a fake `studio.edit_script` so the turn-work summary
  // ("N tệp thay đổi +A −D") can be exercised end-to-end without a Roblox Studio connection.
  'studio-edit',
] as const;
export type FakeScript = (typeof FAKE_SCRIPTS)[number];

export interface FakeAdapterOptions {
  defaultScript?: FakeScript;
  /** Delay between slow-script chunks. Kept injectable so unit tests do not wait on wall clock. */
  chunkDelayMs?: number;
}

export function scriptFromMessage(content: string, fallback: FakeScript): FakeScript {
  const match = /^\/script\s+([a-z-]+)/.exec(content.trim());
  const candidate = match?.[1] as FakeScript | undefined;
  return candidate && (FAKE_SCRIPTS as readonly string[]).includes(candidate) ? candidate : fallback;
}

const MODELS: ModelInfo[] = [
  // 128k, not 8k: the real prompt (working agreement + 6 skills + 35 Studio tool schemas) already
  // needs ~9.3k tokens, so an 8k fake made every tool turn die with CONTEXT_OVERFLOW — a property of
  // the fixture, not of the product. Measured 2026-11-06 with the Studio surface connected.
  { id: 'fake-tools', name: 'Fake tools (E2E)', provider: FAKE_PROVIDER_ID, providerLabel: 'Fake', context: 128_000, efforts: ['low', 'medium', 'high'], supportsTools: true },
  { id: 'fake-text', name: 'Fake text (E2E)', provider: FAKE_PROVIDER_ID, providerLabel: 'Fake', context: 32_768, efforts: ['low', 'medium', 'high'], supportsTools: false },
];

/** Resolves early when the turn is aborted; the caller checks `signal.aborted` before each yield. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): ProviderAdapter {
  const fallback = options.defaultScript ?? 'text';
  const slowDelay = options.chunkDelayMs ?? 180;

  return {
    id: FAKE_PROVIDER_ID,
    name: 'Fake (E2E)',
    // Registry calls these with an empty string when no matching key is present. The fake provider is
    // deliberately always "configured", so both are inert.
    setApiKey: () => undefined,
    setBaseUrl: () => undefined,
    listModels: async () => MODELS.map((model) => ({ ...model })),
    stream(request: LlmRequest): AsyncIterable<StreamEvent> {
      return fakeStream(request, fallback, slowDelay);
    },
  };
}

async function* fakeStream(request: LlmRequest, fallback: FakeScript, slowDelay: number): AsyncIterable<StreamEvent> {
  const signal = request.signal;
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
  const script = scriptFromMessage(lastUser?.content ?? '', fallback);
  const hasToolResult = request.messages.some((message) => message.role === 'tool');
  // The studio scripts run back-to-back in one session, so "a tool result exists" is too coarse:
  // each script must only skip its own call once THAT call has come back.
  const answered = new Set(
    request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId ?? ''),
  );

  if (script === 'missing-key') {
    // Same code the registry/route already use end-to-end (registry.ts:18, routes/chat.ts:36).
    // `retryable: false` keeps the loop from re-running a turn that can never succeed.
    yield { type: 'error', error: { code: 'NO_PROVIDER', message: 'No usable provider is configured', retryable: false } };
    yield { type: 'finish', reason: 'error' };
    return;
  }

  if (script === 'studio-state' && !answered.has('fake_studio_1')) {
    // Read-only: `get_studio_state` is `auto`/low in the policy table, so no modal appears.
    yield { type: 'tool_call_start', callId: 'fake_studio_1', name: 'studio.get_studio_state' };
    if (signal.aborted) return;
    yield { type: 'tool_call_delta', callId: 'fake_studio_1', argsDelta: '{}' };
    if (signal.aborted) return;
    // No `studio_id`: the gateway resolves and injects it (Task 31B Ruling M2).
    yield { type: 'tool_call_end', callId: 'fake_studio_1', name: 'studio.get_studio_state', args: {} };
    yield { type: 'finish', reason: 'tool_calls' };
    return;
  }

  if (script === 'studio-insert' && !answered.has('fake_studio_2')) {
    // Mutating: `insert_asset` is `ask`/medium, so the approval modal must appear. Denying it means
    // nothing ever reaches the place.
    // The live schema wants camelCase `assetId`; the first run used snake_case and the pipeline
    // correctly rejected it BEFORE asking for approval (`INVALID_ARGS`).
    const args = { assetId: '0', assetName: 'Morphi demo' };
    yield { type: 'tool_call_start', callId: 'fake_studio_2', name: 'studio.insert_asset' };
    if (signal.aborted) return;
    yield { type: 'tool_call_delta', callId: 'fake_studio_2', argsDelta: JSON.stringify(args) };
    if (signal.aborted) return;
    yield { type: 'tool_call_end', callId: 'fake_studio_2', name: 'studio.insert_asset', args };
    yield { type: 'finish', reason: 'tool_calls' };
    return;
  }

  if (script === 'studio-edit' && !answered.has('fake_edit_1')) {
    // Two edits to the SAME file: the summary must count it once (last write wins) while the
    // per-file churn reflects the final content. A second, distinct file proves the aggregate
    // sums across files. Both calls are `auto`, so the turn settles in one round.
    const firstArgs = {
      path: 'src/ServerScriptService/Combat.lua',
      old: '',
      source: 'local Combat = {}\n\nreturn Combat',
    };
    yield { type: 'tool_call_start', callId: 'fake_edit_1', name: 'studio.edit_script' };
    if (signal.aborted) return;
    yield { type: 'tool_call_delta', callId: 'fake_edit_1', argsDelta: JSON.stringify(firstArgs) };
    if (signal.aborted) return;
    yield { type: 'tool_call_end', callId: 'fake_edit_1', name: 'studio.edit_script', args: firstArgs };
    yield { type: 'finish', reason: 'tool_calls' };
    return;
  }

  if (script === 'studio-edit' && !answered.has('fake_edit_2')) {
    const secondArgs = {
      path: 'src/ReplicatedStorage/Config.lua',
      old: 'return {}\n',
      source: 'return {\n  speed = 16,\n  jump = 50,\n}\n',
    };
    yield { type: 'tool_call_start', callId: 'fake_edit_2', name: 'studio.edit_script' };
    if (signal.aborted) return;
    yield { type: 'tool_call_delta', callId: 'fake_edit_2', argsDelta: JSON.stringify(secondArgs) };
    if (signal.aborted) return;
    yield { type: 'tool_call_end', callId: 'fake_edit_2', name: 'studio.edit_script', args: secondArgs };
    yield { type: 'finish', reason: 'tool_calls' };
    return;
  }

  if (script === 'studio-edit') {
    yield { type: 'text_delta', text: 'Đã cập nhật Combat.lua và Config.lua.' };
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  if (script === 'tool-then-text' && !hasToolResult) {
    const callId = 'fake_call_1';
    const args = { text: 'probe-from-fake' };
    const serialized = JSON.stringify(args);
    yield { type: 'tool_call_start', callId, name: FAKE_TOOL_NAME };
    if (signal.aborted) return;
    await pause(1, signal);
    yield { type: 'tool_call_delta', callId, argsDelta: serialized };
    if (signal.aborted) return;
    yield { type: 'tool_call_end', callId, name: FAKE_TOOL_NAME, args };
    yield { type: 'finish', reason: 'tool_calls' };
    return;
  }

  // A chosen effort must produce real reasoning frames, otherwise the UI's ThinkingBlock is untested.
  if (request.effort) {
    for (const chunk of [`Mức ${request.effort}: `, 'đang cân nhắc trước khi trả lời. ']) {
      if (signal.aborted) return;
      yield { type: 'reasoning_delta', text: chunk };
    }
  }

  const lastTool = [...request.messages].reverse().find((message) => message.role === 'tool');
  // The tool message may carry JSON-escaped newlines; a demo reply should read like a sentence.
  const quoted = (lastTool?.content ?? '').replace(/\\n/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 240);
  const chunks: string[] = script === 'studio-state'
    // Quote the REAL result, so the transcript shows what Studio actually answered.
    ? [`Studio trả lời: "${quoted}". `, 'Đó là trạng thái hiện tại của place đang mở.']
    : script === 'studio-insert'
      ? ['Mình đã dừng trước khi chèn asset — thao tác này cần bạn phê duyệt.']
      : script === 'tool-then-text'
    ? ['Tool đã chạy xong. ', 'Đây là câu trả lời cuối cùng.']
    : script === 'regenerate'
      ? ['Câu trả lời được tạo lại ', 'từ fake adapter.']
      : script === 'slow' || script === 'cancel'
        ? Array.from({ length: 14 }, (_, index) => `đoạn ${index + 1} `)
        : ['Xin chào! ', 'Đây là phản hồi ', 'từ fake adapter.'];

  const delay = script === 'slow' || script === 'cancel' ? slowDelay : 0;
  for (const chunk of chunks) {
    if (signal.aborted) return;
    yield { type: 'text_delta', text: chunk };
    if (signal.aborted) return;
    await pause(delay, signal);
  }
  if (signal.aborted) return;
  yield { type: 'usage', usage: { promptTokens: 12, completionTokens: chunks.length, totalTokens: 12 + chunks.length } };
  yield { type: 'finish', reason: 'stop' };
}
