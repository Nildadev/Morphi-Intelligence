import { createServer } from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config';
import { createApp } from './app';
import { openDatabase } from './db/connection';
import { createHarness } from './harness/harness';
import type { JsonSchema } from './harness/shared/types';
import { GeminiAdapter } from './harness/llm/gemini';
import { createFakeAdapter, FAKE_PROVIDER_ID, FAKE_SCRIPTS, FAKE_TOOL_NAME, type FakeScript } from './harness/llm/fake';
import { LlmRegistry } from './harness/llm/registry';
import { createProviderSettingsStore } from './harness/llm/settings';
import { OpenAICompatibleAdapter } from './harness/llm/openaiCompatible';
import { MCP_SETTINGS_ID, createMcpGateway, createMcpLog } from './harness/mcp/serviceGateway';
import { McpService } from './services/McpService';
import { mountRoutes } from './routes';

// Root `.env` for `npm run dev`, `server/.env` for a packaged build; real keys normally arrive
// from Electron main over `parentPort` instead.
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const config = loadConfig();
const db = openDatabase(config.dbPath);
const providerSettings = createProviderSettingsStore(db);

// Task 31: the Settings override is read live (so `PUT /api/mcp/path` needs no restart) and passed
// to the resolver at SPAWN time, never trusted from the stored row. One log object is shared by the
// bridge and the gateway so stderr, resolver hints and lifecycle lines land in the same panel.
const mcpLog = createMcpLog();
const mcpPathOverride = (): string | null => providerSettings.get(MCP_SETTINGS_ID)?.baseUrl ?? null;
const mcpBridge = new McpService({
  onLog: (line) => mcpLog.push(line),
  pathOverride: mcpPathOverride,
});
const mcp = createMcpGateway(mcpBridge, {
  log: mcpLog,
  pathOverride: mcpPathOverride,
});

// Task 25 / R25-2: the fake seam belongs HERE, at the composition root, because this is where the
// adapter list, the credentials and the auto priority are actually built. `harness.ts` only receives
// an already-constructed registry. In fake mode no real adapter is registered at all, so an E2E run
// cannot reach the network even if a stray env key happens to be present.
const fakeMode = process.env.MORPHI_FAKE_LLM === '1';
const fakeScript = (FAKE_SCRIPTS as readonly string[]).includes(process.env.MORPHI_FAKE_SCRIPT ?? '')
  ? (process.env.MORPHI_FAKE_SCRIPT as FakeScript)
  : 'text';

const registry = fakeMode
  ? new LlmRegistry(
      [createFakeAdapter({ defaultScript: fakeScript })],
      [FAKE_PROVIDER_ID, ...config.autoPriority],
    )
  : new LlmRegistry([
      new GeminiAdapter(),
      new OpenAICompatibleAdapter({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }),
      new OpenAICompatibleAdapter({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
      new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }),
      new OpenAICompatibleAdapter({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }),
      new OpenAICompatibleAdapter({ id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' }),
      new OpenAICompatibleAdapter({ id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' }),
      new OpenAICompatibleAdapter({ id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1' }),
      new OpenAICompatibleAdapter({ id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' }),
      new OpenAICompatibleAdapter({ id: 'together', name: 'Together', baseUrl: 'https://api.together.xyz/v1' }),
      new OpenAICompatibleAdapter({ id: 'fireworks', name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1' }),
      new OpenAICompatibleAdapter({ id: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai/v1' }),
      new OpenAICompatibleAdapter({ id: 'deepinfra', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai' }),
      // NVIDIA NIM and Kilo Gateway are the two gateways whose `/models` listing carries no
      // metadata (ids and `owned_by` only), so their lineup comes from `providerCatalog.ts`.
      new OpenAICompatibleAdapter({ id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' }),
      new OpenAICompatibleAdapter({ id: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway' }),
      // The local DeepSeek web bridge (github.com/sums001/Deepseek-API): a Python server you run
      // on your own machine that turns your signed-in chat.deepseek.com account into an
      // OpenAI-compatible endpoint on 127.0.0.1:8000 — no API key ("the API key is required by the
      // SDK but ignored"). It is keyless in the registry (isConfigured), so saving a key is
      // optional; its two model ids carry no metadata on the wire, hence the hand-written cards
      // in `providerCatalog.ts`. `thinking` (not an effort ladder) enables DeepThink reasoning.
      new OpenAICompatibleAdapter({ id: 'deepseek-chat', name: 'DeepSeek Chat', baseUrl: 'http://127.0.0.1:8000/v1' }),
    ], config.autoPriority);

const envKeys: Record<string, string> = {};
for (const [providerId, value] of Object.entries({
  google: process.env.GEMINI_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
  groq: process.env.GROQ_API_KEY,
  mistral: process.env.MISTRAL_API_KEY,
  xai: process.env.XAI_API_KEY,
  cerebras: process.env.CEREBRAS_API_KEY,
  together: process.env.TOGETHER_API_KEY,
  fireworks: process.env.FIREWORKS_API_KEY,
  perplexity: process.env.PERPLEXITY_API_KEY,
  deepinfra: process.env.DEEPINFRA_API_KEY,
  nvidia: process.env.NVIDIA_API_KEY,
  kilo: process.env.KILO_API_KEY,
  // Optional only: the bridge authenticates with the browser session it manages itself, so the
  // provider is usable with no credential at all (registry KEYLESS_PROVIDER_IDS).
  'deepseek-chat': process.env.DEEPSEEK_CHAT_API_KEY,
})) {
  if (value) envKeys[providerId] = value;
}
registry.setCredentials(fakeMode ? { [FAKE_PROVIDER_ID]: 'fake-e2e-credential' } : envKeys);

const harness = createHarness({
  db,
  llm: registry,
  mcp,
  titleModel: config.titleModel,
  providerSettings,
  compaction: config.compaction,
});

// The fake tool is the only tool that asks for approval, so E2E can drive the real ApprovalModal
// (allow/deny) without a Roblox Studio connection. `approval: 'ask'` goes through the same
// ApprovalService + POST /api/approvals/:id path as a high-risk production tool.
if (fakeMode) {
  harness.tools.register({
    name: FAKE_TOOL_NAME,
    description: 'E2E-only tool: echo a string back after the user approves the call.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args: unknown): Promise<unknown> {
      return { echo: (args as { text?: string } | null | undefined)?.text ?? '' };
    },
    isConcurrencySafe: true,
    approval: 'ask',
    presentation: { label: 'E2E echo', risk: 'low' },
  });

  // E2E-only `studio.edit_script`: the real Studio tool lives on the MCP surface and needs a
  // connected place, so without this the turn-work summary ("N tệp thay đổi +A −D") could only
  // be tested at the unit level. The NAME is the contract: the client's `turnChanges` module
  // keys off `EDIT_TOOL_NAMES`, so a differently named fake would render no summary at all.
  // `approval: 'auto'` keeps the demo one turn instead of two (no modal to dismiss).
  harness.tools.register({
    name: 'studio.edit_script',
    description: 'E2E-only tool: pretend to rewrite a script and return its diff shape.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Script path' },
        old: { type: 'string', description: 'Previous source' },
        source: { type: 'string', description: 'New source' },
      },
      required: ['path', 'source'],
      additionalProperties: false,
    },
    async execute(args: unknown): Promise<unknown> {
      const record = (args ?? {}) as { path?: string; source?: string };
      return { ok: true, path: record.path ?? '', bytes: (record.source ?? '').length };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'E2E edit script', risk: 'low' },
  });

  // The rest of the `/script alltool` tour. Each is the smallest tool that produces a distinct
  // transcript row shape (read, search, shell, write, multi-edit, failure), so the whole log can be
  // inspected in one turn. Names are the real ones where the client maps an icon by name.
  const tourTool = (
    name: string,
    label: string,
    properties: Record<string, JsonSchema>,
    required: string[],
    execute: (args: Record<string, unknown>) => unknown,
    risk: 'low' | 'medium' = 'low',
  ) => harness.tools.register({
    name,
    description: `E2E-only tool for the alltool design tour: ${label}.`,
    parameters: { type: 'object', properties, required, additionalProperties: true },
    async execute(args: unknown): Promise<unknown> {
      return execute((args ?? {}) as Record<string, unknown>);
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label, risk },
  });

  tourTool('studio.script_read', 'Đọc script', { path: { type: 'string' } }, ['path'],
    (args) => ({ path: args.path ?? '', source: '-- nội dung giả lập\nreturn {}' }));
  tourTool('studio.search_game_tree', 'Tìm trong cây', { query: { type: 'string' } }, ['query'],
    (args) => ({ query: args.query ?? '', matches: ['Workspace.Dummy.Humanoid', 'Workspace.NPC.Humanoid'] }));
  tourTool('run_command', 'Chạy lệnh', { cmd: { type: 'string' } }, ['cmd'],
    (args) => ({ exitCode: 0, stdout: `$ ${String(args.cmd ?? '')}\n0 problems found` }));
  tourTool('studio.write_script', 'Ghi script',
    { path: { type: 'string' }, source: { type: 'string' } }, ['path', 'source'],
    (args) => ({ ok: true, path: args.path ?? '', bytes: String(args.source ?? '').length }), 'medium');
  tourTool('studio.multi_edit', 'Sửa nhiều script', { edits: { type: 'array' } }, ['edits'],
    (args) => ({ ok: true, edited: Array.isArray(args.edits) ? args.edits.length : 0 }), 'medium');
  tourTool('studio.execute_luau', 'Chạy mã Luau', { code: { type: 'string' } }, ['code'],
    () => { throw new Error('boom: lỗi giả lập cho tour thiết kế'); }, 'medium');
}

for (const setting of providerSettings.list()) {
  const custom = setting.providerId.startsWith('custom:');
  if (custom && setting.baseUrl) {
    registry.addCustomProvider(setting.providerId, setting.baseUrl);
  }
  // A row written by an older build can still carry a built-in baseUrl. Replaying it would move provider
  // traffic — and the in-memory key — to a host the user never chose, so only custom rows keep it.
  registry.setProviderConfig(setting.providerId, custom ? setting : { ...setting, baseUrl: undefined });
}

const app = createApp({
  token: config.token,
  version: '1.1.0',
  staticDir: config.clientDistPath,
  mount: (expressApp) => mountRoutes(expressApp, harness),
});
const server = createServer(app);

type ParentPort = {
  on(event: 'message', listener: (event: unknown) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

if (parentPort) {
  // utilityProcess wraps messages in a MessageEvent-like object ({ data }), while
  // plain Node IPC (tests, child_process) delivers the payload itself. Accept both.
  parentPort.on('message', (event: unknown) => {
    const message = ((event as { data?: unknown } | null | undefined)?.data ?? event) as
      | { type?: unknown; keys?: unknown }
      | null
      | undefined;
    if (!message || message.type !== 'credentials') return;
    if (!message.keys || typeof message.keys !== 'object' || Array.isArray(message.keys)) {
      registry.setCredentials({});
      void registry.refreshModels();
      return;
    }
    const keys: Record<string, string> = {};
    for (const [providerId, apiKey] of Object.entries(message.keys as Record<string, unknown>)) {
      if (typeof apiKey === 'string' && apiKey) keys[providerId] = apiKey;
    }
    registry.setCredentials(keys);
    // The key list is the only thing that makes a provider usable, so the catalog is re-pulled
    // here: a model picker cannot show a model the registry never fetched.
    void registry.refreshModels();
  });
}

server.listen(config.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  parentPort?.postMessage({ type: 'ready', port });
  console.log(`Morphi server listening on http://127.0.0.1:${port}`);
  void registry.refreshModels();

  // Task 31 / Task 17 review I2: one background connect after listen, then sync the tool mirror.
  // Without it the 34 Studio tools only appear after a human presses "Kết nối lại". Fake E2E mode
  // deliberately skips this: no Studio child, no network, no undefined third-party bridge.
  if (!fakeMode) {
    void (async () => {
      try {
        await mcp.reconnect();
        if (mcp.connected) await harness.syncTools();
      } catch (error) {
        mcpLog.push(`MCP boot connect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }
});

// Task 31 / Task 17 review Minor 7: quit must not leave an orphaned StudioMCP child holding the pipe.
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try { await mcp.close(); } catch { /* best effort */ }
    try { await harness.dispose(); } catch { /* best effort */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  })();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
