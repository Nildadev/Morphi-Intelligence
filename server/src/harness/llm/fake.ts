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
  // Real-end-to-end probe: calls the REAL `studio.multi_edit` on the connected place so the full
  // HTTP path (POST /chat/stream → pipeline snapshot → Studio mutate → checkpoint → POST /undo-turn
  // → Studio restore) runs against live Studio, not a fake tool. Used by MORPHI_LIVE_STUDIO e2e.
  'studio-real-edit',
  // Batch-undo probe: TWO real `studio.multi_edit` calls on two DIFFERENT scripts in ONE turn, so
  // the turn-level undo can be proved to be all-or-nothing (one refused target ⇒ nothing written).
  'studio-batch-edit',
  // Delete-undo probe: destroys a real instance through `execute_luau` (the server ships no delete
  // tool), so the pre-state capture has to read the tree BEFORE the destroy and undo has to
  // recreate it. Exercised against live Studio by `scripts/e2e-live-undo.mjs` scenario 3.
  'studio-delete',
  // Move probe: changes a real part's CFrame through `execute_luau`, so the snapshot has to capture
  // the transform (the bag only carries the pseudo-paths `CFrame.Position`/`CFrame.Rotation`) and the
  // undo has to put position AND rotation back. Scenario 4 of `scripts/e2e-live-undo.mjs`.
  'studio-move',
  // Rename/reparent probe: neither value is in the property bag, so both used to be silently
  // un-undoable while the checkpoint still claimed restorable. Scenario 5 of the live e2e.
  'studio-rename',
  // Design tour: one turn that calls every row shape the transcript can render (read, search,
  // command, edit, create, multi-edit, failure), so the whole log styling can be inspected in a
  // single screen without a Roblox Studio connection.
  'alltool',
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

  // Real-end-to-end probe: mutate an EXISTING script on the CONNECTED place via the real
  // `studio.multi_edit` tool, so the HTTP turn → snapshot → Studio write → checkpoint → undo-turn →
  // Studio restore path is exercised against live Studio. The path is fixed and must pre-exist (the
  // e2e harness creates it first); editing an existing script means the snapshot captures a real old
  // source and the checkpoint is restorable, which a create-from-empty would not prove.
  if (script === 'studio-real-edit' && !answered.has('fake_real_edit_1')) {
    // These args are the REAL `multi_edit` schema (measured live): `datamodel_type` is required, so
    // a fixture without it died with `INVALID_ARGS: data must have required property
    // 'datamodel_type'` and the whole undo probe saw a non-mutating turn. `className` is omitted
    // because the script already exists — it is only read when multi_edit has to create one.
    const args = {
      file_path: 'ServerScriptService.MorphiE2E',
      datamodel_type: 'Edit',
      edits: [{ old_string: 'local V = 1\nreturn V', new_string: 'local V = 2\nreturn V' }],
    };
    yield { type: 'tool_call_start', callId: 'fake_real_edit_1', name: 'studio.multi_edit' };
    if (signal.aborted) return;
    yield { type: 'tool_call_delta', callId: 'fake_real_edit_1', argsDelta: JSON.stringify(args) };
    if (signal.aborted) return;
    yield { type: 'tool_call_end', callId: 'fake_real_edit_1', name: 'studio.multi_edit', args };
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

  if (script === 'studio-batch-edit') {
    // Two mutating calls, one per round (the loop needs each result back before asking again). Both
    // belong to the same turn, so `POST /undo-turn` gets two callIds: exactly the batch case where a
    // single drifted target must refuse the WHOLE turn instead of half-restoring it.
    const batch: Array<{ id: string; args: Record<string, unknown> }> = [
      {
        id: 'fake_batch_1',
        args: {
          file_path: 'ServerScriptService.MorphiE2E',
          datamodel_type: 'Edit',
          edits: [{ old_string: 'local V = 1\nreturn V', new_string: 'local V = 2\nreturn V' }],
        },
      },
      {
        id: 'fake_batch_2',
        args: {
          file_path: 'ServerScriptService.MorphiE2EB',
          datamodel_type: 'Edit',
          edits: [{ old_string: 'local W = 1\nreturn W', new_string: 'local W = 2\nreturn W' }],
        },
      },
    ];
    const pendingBatch = batch.find((entry) => !answered.has(entry.id));
    if (pendingBatch !== undefined) {
      yield { type: 'tool_call_start', callId: pendingBatch.id, name: 'studio.multi_edit' };
      if (signal.aborted) return;
      yield { type: 'tool_call_delta', callId: pendingBatch.id, argsDelta: JSON.stringify(pendingBatch.args) };
      if (signal.aborted) return;
      yield { type: 'tool_call_end', callId: pendingBatch.id, name: 'studio.multi_edit', args: pendingBatch.args };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', text: 'Đã sửa hai script MorphiE2E và MorphiE2EB trong cùng một lượt.' };
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  if (script === 'studio-delete') {
    const path = 'Workspace.MorphiE2EModel';
    const callId = 'fake_delete_1';
    if (!answered.has(callId)) {
      // Same shape our own `deleteInstance` emits, so `pathFromLuau` reads the target out of the code
      // exactly as it would for a real model-written delete.
      const code = 'local segs = {"Workspace", "MorphiE2EModel"}\n'
        + 'local root = game:GetService(segs[1])\n'
        + 'for i = 2, #segs do\n  if root == nil then break end\n  root = root:FindFirstChild(segs[i])\nend\n'
        + 'if root == nil then return "error: not found" end\nroot:Destroy()\nreturn "ok"';
      const args = { code, datamodel_type: 'Edit' };
      yield { type: 'tool_call_start', callId, name: 'studio.execute_luau' };
      if (signal.aborted) return;
      yield { type: 'tool_call_delta', callId, argsDelta: JSON.stringify(args) };
      if (signal.aborted) return;
      yield { type: 'tool_call_end', callId, name: 'studio.execute_luau', args };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', text: `Đã xoá ${path} trên place thật.` };
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  if (script === 'studio-move') {
    const callId = 'fake_move_1';
    if (!answered.has(callId)) {
      const code = 'local segs = {"Workspace", "MorphiE2EPart"}\n'
        + 'local root = game:GetService(segs[1])\n'
        + 'for i = 2, #segs do\n  if root == nil then break end\n  root = root:FindFirstChild(segs[i])\nend\n'
        + 'if root == nil then return "error: not found" end\n'
        + 'root.CFrame = CFrame.new(50, 10, 0) * CFrame.Angles(0, math.pi / 2, 0)\n'
        + 'return "ok"';
      const args = { code, datamodel_type: 'Edit' };
      yield { type: 'tool_call_start', callId, name: 'studio.execute_luau' };
      if (signal.aborted) return;
      yield { type: 'tool_call_delta', callId, argsDelta: JSON.stringify(args) };
      if (signal.aborted) return;
      yield { type: 'tool_call_end', callId, name: 'studio.execute_luau', args };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', text: 'Đã di chuyển MorphiE2EPart trên place thật.' };
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  if (script === 'studio-rename') {
    const callId = 'fake_rename_1';
    if (!answered.has(callId)) {
      const code = 'local segs = {"Workspace", "MorphiE2EPart"}\n'
        + 'local root = game:GetService(segs[1])\n'
        + 'for i = 2, #segs do\n  if root == nil then break end\n  root = root:FindFirstChild(segs[i])\nend\n'
        + 'if root == nil then return "error: not found" end\n'
        + 'local folder = game:GetService("Workspace"):FindFirstChild("MorphiE2EFolder")\n'
        + 'if folder == nil then return "error: no folder" end\n'
        + 'root.Name = "MorphiE2ERenamed"\n'
        + 'root.Parent = folder\n'
        + 'return "ok"';
      const args = { code, datamodel_type: 'Edit' };
      yield { type: 'tool_call_start', callId, name: 'studio.execute_luau' };
      if (signal.aborted) return;
      yield { type: 'tool_call_delta', callId, argsDelta: JSON.stringify(args) };
      if (signal.aborted) return;
      yield { type: 'tool_call_end', callId, name: 'studio.execute_luau', args };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', text: 'Đã đổi tên và chuyển MorphiE2EPart vào MorphiE2EFolder.' };
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  if (script === 'studio-real-edit') {
    yield { type: 'text_delta', text: 'Đã ghi script MorphiE2E trên place thật qua Studio MCP.' };
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  // Design tour: one round of every row shape. Each call has its own id, so the turn only moves on
  // once ALL of them have come back — otherwise the second round would re-issue the first call.
  if (script === 'alltool') {
    const tour: Array<{ id: string; name: string; args: Record<string, unknown> }> = [
      // Read: the plainest row (icon + label + path + no status once settled).
      { id: 'fake_all_read', name: 'studio.script_read', args: { path: 'src/ServerScriptService/Combat.lua' } },
      // Search: a query instead of a path, so the argument-summary branch is exercised.
      { id: 'fake_all_search', name: 'studio.search_game_tree', args: { query: 'Humanoid' } },
      // A shell-style tool: proves the `cmd` summary key renders and truncates.
      { id: 'fake_all_cmd', name: 'run_command', args: { cmd: 'selene src/ServerScriptService/Combat.lua' } },
      // Write: a brand-new script, so the churn is all additions.
      { id: 'fake_all_write', name: 'studio.write_script', args: { path: 'src/ServerScriptService/Round.lua', source: 'local Round = {}\n\nfunction Round.start()\nend\n\nreturn Round' } },
      // Edit: before/after on an existing script, so a diff has both + and − rows.
      { id: 'fake_all_edit', name: 'studio.edit_script', args: { path: 'src/ReplicatedStorage/Config.lua', old: 'return {}\n', source: 'return {\n  speed = 16,\n  jump = 50,\n}\n' } },
      // Multi-edit: two files in one call, so the per-script sections render.
      { id: 'fake_all_multi', name: 'studio.multi_edit', args: { edits: [
        { path: 'src/ServerScriptService/A.lua', old: '', source: 'return 1' },
        { path: 'src/ServerScriptService/B.lua', old: '', source: 'return 2\n' },
      ] } },
      // A call that fails, so the error status + red row are visible next to the successes.
      { id: 'fake_all_fail', name: 'studio.execute_luau', args: { code: 'error("boom")' }, fail: true },
    ] as Array<{ id: string; name: string; args: Record<string, unknown>; fail?: boolean }>;

    const pending = tour.find((entry) => !answered.has(entry.id));
    if (pending !== undefined) {
      // Issue ONE call per round. The loop then returns a tool result and asks again; issuing all
      // seven in a single round would exceed the per-step cap and hide the later rows.
      yield { type: 'tool_call_start', callId: pending.id, name: pending.name };
      if (signal.aborted) return;
      yield { type: 'tool_call_delta', callId: pending.id, argsDelta: JSON.stringify(pending.args) };
      if (signal.aborted) return;
      yield { type: 'tool_call_end', callId: pending.id, name: pending.name, args: pending.args };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }

    yield { type: 'text_delta', text: 'Đã chạy xong lượt thử mọi loại tool: đọc, tìm, lệnh, ghi, sửa, sửa nhiều tệp và một lỗi.' };
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
