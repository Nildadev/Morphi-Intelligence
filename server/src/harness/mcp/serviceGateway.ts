import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../../http/redact';
import { isCanonicalBase64, isImageMime } from '../attachments/store';
import type { ToolSchema } from '../llm/types';
import type { JsonSchema } from '../shared/types';
import type { McpGateway, McpSource, ToolImage } from '../tools/types';
import { StudioContextError, injectStudioId, resolveStudio, stripStudioId } from './studioContext';
import { mcpToolName, serverToolName } from './toolNaming';

/** The Settings MCP path lives in the generic `provider_settings` table under this row id. */
export const MCP_SETTINGS_ID = 'mcp';
export const MCP_LOG_LIMIT = 50;

const MCP_EXECUTABLE = /\.(?:exe|bat|cmd)$/i;
/** Rejected before the process is spawned: an override is a path, never a command line. */
const SHELL_METACHARACTERS = /[&|;"`[\n\r]/;

/**
 * The only basenames that may be spawned from a folder the user picked: the official server's own.
 * Everything else has to live under a root Roblox itself owns (see `officialMcpRoots`).
 */
const OFFICIAL_MCP_BASENAMES = new Set(['rbx-studio-mcp', 'rbx-studio-mcp.exe']);

/** Test seams for the allowlist: host defaults are what production runs with. */
export interface McpPathOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  exists?: (filePath: string) => boolean;
}

/**
 * Path parsing has to agree with the platform the candidate belongs to, or a win32 drive letter is
 * "relative" when a darwin rule is being tested on a Windows box.
 */
function implFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function hostPlatform(options: McpPathOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

/**
 * The roots Roblox's own installer writes to. Inside one of them the filename was chosen by Roblox,
 * not by whoever typed the path, so a `.bat` there is as trustworthy as an official basename is
 * elsewhere. No root is assumed on other platforms: there is no official installer to honour.
 */
export function officialMcpRoots(options: McpPathOptions = {}): string[] {
  const platform = hostPlatform(options);
  if (platform === 'darwin') return ['/Applications/RobloxStudio.app'];
  if (platform !== 'win32') return [];
  const localAppData = (options.env ?? process.env).LOCALAPPDATA?.trim();
  return localAppData ? [path.win32.join(localAppData, 'Roblox')] : [];
}

/**
 * Official basename, or inside an official root once `..` has been collapsed.
 * Exported so Task 31's resolver can re-run the SAME containment test on `fs.realpath()` output:
 * a junction placed inside the Roblox root is lexically contained but really points elsewhere.
 */
export function isOfficialMcpLocation(candidate: string, options: McpPathOptions): boolean {
  const platform = hostPlatform(options);
  const impl = implFor(platform);
  // Windows paths are case-insensitive, so `ROBLOX\` and `Roblox\` are the same contract.
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value);
  if (OFFICIAL_MCP_BASENAMES.has(fold(impl.basename(candidate)))) return true;

  const target = fold(impl.resolve(candidate));
  return officialMcpRoots(options).some((root) => {
    // `relative` is how a resolved path stops a `..` from escaping the Roblox root.
    const relative = impl.relative(fold(impl.resolve(root)), target);
    return relative !== '' && !relative.startsWith('..') && !impl.isAbsolute(relative);
  });
}

export interface McpLog {
  push(line: string): void;
  lines(): string[];
  clear(): void;
}

export interface McpStatus {
  connected: boolean;
  studioLinked: boolean;
  server: { source: McpSource; path: string | null; version: string | null };
  /** The place Morphi resolved from `list_roblox_studios`, or null when none is open. */
  studio: { id: string; name: string | null } | null;
  /** Tools published under `studio.*` by the last `listTools()`; 0 before the first listing. */
  toolCount: number;
  /** The last failure, in the vocabulary `vi.errors` knows. Cleared by the next successful call. */
  lastError: { code: string; message: string } | null;
  logs: string[];
}

/**
 * Failure vocabulary shared by the gateway and `vi.errors` (Task 31C Step 2). Every member is
 * reachable: the four `StudioContextError`/wire cases come from a real `callTool`, `MCP_SPAWN_FAILED`
 * from a reconnect that could not start the official server.
 */
export type McpErrorCode =
  | 'STUDIO_NOT_CONNECTED'
  | 'MULTIPLE_STUDIOS'
  | 'MCP_TOOL_TIMEOUT'
  | 'STUDIO_RESTART_REQUIRED'
  | 'MCP_TOOL_FAILED'
  | 'MCP_SPAWN_FAILED';

/** JSON-RPC codes the SDK raises, named once so the mapping below has no magic numbers. */
const REQUEST_TIMEOUT_CODE = -32001;
const INTERNAL_ERROR_CODE = -32603;

/** How the official proxy words "the place is gone"; anything else is a call-level failure. */
const PLACE_GONE = /not connected|no studio|no place|studio (?:is )?closed|disconnected/i;

/**
 * The part of `McpService` the gateway drives. Task 31 made `serverInfo` MANDATORY: a bridge can
 * only report a source/path/version it actually resolved and saw in the MCP handshake, so no
 * caller can present an unidentified third-party process as the official Roblox server.
 */
export interface McpBridge {
  readonly connected: boolean;
  readonly studioLinked: boolean;
  readonly serverInfo: { source: McpSource; path: string | null; version: string | null };
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools?: unknown }>;
  /** Task 31B Step 3: the turn's signal must cancel the in-flight MCP request. */
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

const NO_NAMED_SERVER = { source: 'none', path: null, version: null } as const;

interface RawMcpTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

interface RawMcpToolResult {
  content?: unknown;
  isError?: unknown;
}

interface RawMcpContent {
  type?: unknown;
  text?: unknown;
  /** `image` blocks only: the screenshot arrives as base64 plus its mime type. */
  mimeType?: unknown;
  data?: unknown;
}

function basenameOf(candidate: string): string {
  const separator = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'));
  return separator === -1 ? candidate : candidate.slice(separator + 1);
}

function toolSchema(raw: RawMcpTool): ToolSchema | undefined {
  if (typeof raw.name !== 'string' || !raw.name) return undefined;
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    parameters: (raw.inputSchema ?? { type: 'object' }) as JsonSchema,
  };
}

/**
 * One line per image block for the durable text. The pixels themselves ride to vision models
 * out-of-band (`resultImages` → pipeline → the turn's next request); this note is what text-only
 * models and later turns see, so it states the fact without claiming delivery either way.
 */
function describeImage(block: RawMcpContent): string {
  const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image';
  const bytes = typeof block.data === 'string' ? Math.round((block.data.length * 3) / 4) : 0;
  const size = bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
  return `[Ảnh ${mime}, ${size}]`;
}

/**
 * MCP servers disagree about the `data` field: some send raw base64, others send a full
 * `data:image/...;base64,...` URL, and a few wrap lines. Provider adapters expect the raw
 * payload only; the prefixed form makes the upstream request invalid ("body is invalid").
 * Normalise both standard and URL-safe base64 to the canonical padded form the loop can ship.
 */
function normalizeImageData(raw: string): string | undefined {
  const payload = raw.includes(',') ? raw.slice(raw.lastIndexOf(',') + 1) : raw;
  const cleaned = payload.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length === 0) return undefined;
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  return isCanonicalBase64(padded) ? padded : undefined;
}

/** The image blocks a vision model can actually receive; exotic mimes stay a text note only. */
function resultImages(result: unknown): ToolImage[] {
  const content = (result as RawMcpToolResult | null | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const images: ToolImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const raw = block as RawMcpContent;
    if (raw.type !== 'image' || typeof raw.data !== 'string' || raw.data.length === 0) continue;
    if (typeof raw.mimeType !== 'string') continue;
    const mime = raw.mimeType.split(';')[0].trim().toLowerCase();
    if (!isImageMime(mime)) continue;
    const data = normalizeImageData(raw.data);
    if (data !== undefined) images.push({ mime, data });
  }
  return images;
}

/** `content` blocks are the MCP wire format; the model needs their text, and a note for images. */
function resultText(result: unknown): string | undefined {
  const content = (result as RawMcpToolResult | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter((block): block is RawMcpContent => Boolean(block) && typeof block === 'object');
  const text = blocks
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
  const images = blocks.filter((block) => block.type === 'image' && typeof block.data === 'string');
  if (images.length === 0) return text;
  return [text, ...images.map(describeImage)].filter(Boolean).join('\n');
}

/**
 * Shape rules for an MCP executable path, shared with the resolver Task 31 builds on them: absolute,
 * `.exe`/`.bat`/`.cmd`, no NUL and no shell metacharacter. A path that fails here is refused before
 * it is persisted, so a typo cannot poison the next boot's spawn.
 */
export function isWellFormedMcpPath(candidate: unknown, options: McpPathOptions = {}): candidate is string {
  if (typeof candidate !== 'string') return false;
  if (!candidate.trim() || candidate.includes('\0')) return false;
  if (SHELL_METACHARACTERS.test(candidate)) return false;
  if (!implFor(hostPlatform(options)).isAbsolute(candidate)) return false;
  return MCP_EXECUTABLE.test(candidate);
}

/**
 * The one allowlist the route, the gateway and Task 31's resolver all consult: well-formed shape,
 * an official Roblox location (`rbx-studio-mcp[.exe]` basename or an install Roblox owns) and a file
 * that actually exists. Without the location rule any installed executable — `cmd.exe`, a
 * `powershell.exe`, a dropped `anything.exe` — would pass and become a spawn target.
 */
export function isAllowedMcpPath(candidate: unknown, options: McpPathOptions = {}): candidate is string {
  if (!isWellFormedMcpPath(candidate, options)) return false;
  if (!isOfficialMcpLocation(candidate, options)) return false;
  const exists = options.exists ?? ((filePath: string) => fs.existsSync(filePath));
  return exists(candidate);
}

export function createMcpLog(limit = MCP_LOG_LIMIT): McpLog {
  let entries: string[] = [];
  return {
    push(line) {
      const message = redact(String(line ?? '').replace(/\s+/g, ' ').trim());
      if (!message) return;
      entries = [...entries, message].slice(-Math.max(1, limit));
    },
    lines() {
      return [...entries];
    },
    clear() {
      entries = [];
    },
  };
}

/**
 * `McpService` behind the Task 14 `McpGateway` seam. The wrapper is deliberately thin: it maps the
 * MCP wire format to harness types and keeps the lifecycle log, while Task 31 replaces the bridge's
 * spawn (official Roblox server) and its handshake-derived `version`.
 */
export class ServiceMcpGateway implements McpGateway {
  private rejectedOverride: string | undefined;
  private readonly log: McpLog;
  private readonly readPathOverride: () => string | null;
  /** Server tool names whose schema requires `studio_id`; learned from the last `listTools()`. */
  private readonly requiresStudioId = new Set<string>();
  private studioCache: { id: string; name: string | null } | null = null;
  private studioIdAt = 0;
  private publishedToolCount = 0;
  private failure: { code: McpErrorCode; message: string } | null = null;
  /**
   * True once a Studio-dependent call failed: the child process is still alive, but the place is
   * gone. Kept here rather than in the bridge because only the call path observes it.
   */
  private studioLinkLost = false;

  constructor(
    private readonly bridge: McpBridge,
    options: { log?: McpLog; pathOverride?: () => string | null } = {},
  ) {
    this.log = options.log ?? createMcpLog();
    this.readPathOverride = options.pathOverride ?? (() => null);
    // Logged at boot so the panel can show which path the Settings row points at, basename only. It is
    // an intent, never a connection: `server` reports `none` until a bridge names its own process.
    this.log.push(`MCP override: ${basenameOf(this.validatedOverride() ?? '') || 'none'}`);
  }

  get connected(): boolean {
    return this.bridge.connected;
  }

  get studioLinked(): boolean {
    // The bridge only knows what `connect()` saw. A place that closed afterwards shows up here.
    return this.bridge.studioLinked && !this.studioLinkLost;
  }

  get studio(): { id: string; name: string | null } | null {
    return this.studioCache ? { ...this.studioCache } : null;
  }

  get toolCount(): number {
    return this.publishedToolCount;
  }

  get lastError(): { code: string; message: string } | null {
    return this.failure ? { ...this.failure } : null;
  }

  /**
   * Only what the bridge named in its own handshake. A stored override is a setting the route
   * persisted, never proof of a process; `none` therefore means "nothing connected", not "a server
   * whose identity we forgot". The prompt environment and Task 24's panel read this as authoritative.
   */
  get server(): { source: McpSource; path: string | null; version: string | null } {
    return this.bridge.serverInfo ?? NO_NAMED_SERVER;
  }

  get logs(): string[] {
    return this.log.lines();
  }

  // No `status()` here: `mcpStatusOf` is the one implementation of the status body, so a gateway
  // method that duplicates it can only drift.
  /**
   * Publishes the server's tools under `studio.<name>` and removes `studio_id` from the advertised
   * schema (Ruling M2): the model must never be asked for a GUID it cannot know. The original
   * schema stays untouched for validation on the server side.
   */
  async listTools(): Promise<ToolSchema[]> {
    const result = await this.bridge.listTools();
    const raw = Array.isArray(result.tools) ? (result.tools as RawMcpTool[]) : [];
    this.requiresStudioId.clear();
    const schemas = raw.flatMap((tool) => {
      const schema = toolSchema(tool);
      if (!schema) return [];
      const required = ((tool.inputSchema as JsonSchema | undefined)?.required ?? []) as string[];
      if (required.includes('studio_id')) this.requiresStudioId.add(schema.name);
      return [{
        ...schema,
        name: mcpToolName(schema.name),
        parameters: stripStudioId(schema.parameters),
      }];
    });
    this.log.push(`MCP listing: ${schemas.length} tool(s)`);
    // Task 31C Step 1: the panel prints this number, so it must be the count the model was shown.
    this.publishedToolCount = schemas.length;
    // A listing is the natural moment to learn WHICH place is open: the panel must not show
    // "connected" with no place until the user happens to run a tool.
    await this.probeStudio();
    return schemas;
  }

  /**
   * Best-effort place lookup. It never records `lastError`: a cold boot with Studio closed is the
   * normal case, and putting an error row there would blame the user for opening the app.
   */
  private async probeStudio(): Promise<void> {
    try {
      const studio = await resolveStudio(async (tool, args) => {
        const raw = await this.bridge.callTool(tool, args);
        const text = resultText(raw);
        return text === undefined ? raw : text;
      });
      this.studioCache = studio;
      this.studioIdAt = Date.now();
      this.studioLinkLost = false;
    } catch (error) {
      if (!(error instanceof StudioContextError)) throw error;
      this.studioCache = null;
      this.studioIdAt = 0;
      this.studioLinkLost = true;
    }
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error('MCP call cancelled before dispatch');
    const serverName = serverToolName(name);
    try {
      // Resolution is INSIDE the try: "no place open" is the most common failure and the panel
      // must be able to name it, so it cannot escape the error mapping.
      const payload = this.needsStudioId(serverName)
        ? injectStudioId(args, await this.studioIdFor(signal))
        : args;
      const result = await this.bridge.callTool(serverName, payload, signal);
      const text = resultText(result);
      if ((result as RawMcpToolResult | null | undefined)?.isError) {
        // Throwing keeps the pipeline's error path: the model sees a failed call, not a fake success.
        throw new Error(text || `MCP tool ${name} reported an error`);
      }
      this.failure = null;
      this.studioLinkLost = false;
      const images = resultImages(result);
      // The `{ text, images }` convention: the pipeline persists the note and hands the pixels to
      // the loop, which rides them on the next request's user message for vision models.
      if (images.length > 0) return { text: text ?? '', images };
      return text === undefined ? result : text;
    } catch (error) {
      this.recordFailure(error, serverName);
      // Only a lost link invalidates the place: a bad-argument error leaves the place open, so
      // dropping the cached id here would cost a needless re-resolve and clear a true badge.
      if (this.studioLinkLost) {
        this.studioCache = null;
        this.studioIdAt = 0;
      }
      throw error;
    }
  }

  /**
   * One place decides what a failure is called, so the panel and the tool result never disagree.
   * A cancelled turn is not recorded: the pipeline already reports `CANCELLED`, and calling a Stop
   * a timeout would be a lie the user could not undo.
   */
  private recordFailure(error: unknown, serverName: string): void {
    if (error instanceof StudioContextError) {
      this.failure = { code: error.code, message: error.message };
      // Zero places or several: either way nothing is callable right now.
      this.studioLinkLost = true;
      return;
    }
    const code = typeof (error as { code?: unknown } | null)?.code === 'number'
      ? (error as { code: number }).code
      : null;
    const message = error instanceof Error ? error.message : String(error);
    // Only a lost PLACE clears the badge. `Missing required argument: capture_id` (-32602) is a
    // model mistake, not a closed Studio, and the live run proved how easy that lie is to tell.
    if (serverName !== 'list_roblox_studios' && this.needsStudioId(serverName) && PLACE_GONE.test(message)) {
      this.studioLinkLost = true;
    }
    if (code === REQUEST_TIMEOUT_CODE) {
      this.failure = { code: 'MCP_TOOL_TIMEOUT', message };
      return;
    }
    if (code === INTERNAL_ERROR_CODE || /out of date/i.test(message)) {
      // Studio's proxy ships with the Studio build; only a Studio restart replaces it.
      this.failure = { code: 'STUDIO_RESTART_REQUIRED', message };
      return;
    }
    this.failure = { code: 'MCP_TOOL_FAILED', message };
  }

  private needsStudioId(serverName: string): boolean {
    if (this.requiresStudioId.size > 0) return this.requiresStudioId.has(serverName);
    // Before the first listing the only tool known to take no id is the studio enumerator.
    return serverName !== 'list_roblox_studios';
  }

  private async studioIdFor(signal?: AbortSignal): Promise<string> {
    if (this.studioCache && Date.now() - this.studioIdAt < 30_000) return this.studioCache.id;
    // `list_roblox_studios` comes back as MCP content blocks; flatten to its JSON text first.
    const studio = await resolveStudio(async (tool: string, args: unknown) => {
      const raw = await this.bridge.callTool(tool, args, signal);
      const text = resultText(raw);
      return text === undefined ? raw : text;
    });
    this.studioCache = studio;
    this.studioIdAt = Date.now();
    return studio.id;
  }

  async reconnect(): Promise<void> {
    this.log.push('MCP reconnect requested');
    // A reconnect is a fresh verdict: old identity, count and failure must not survive it.
    this.studioCache = null;
    this.studioIdAt = 0;
    this.publishedToolCount = 0;
    this.failure = null;
    this.studioLinkLost = false;
    await this.bridge.close();
    await this.bridge.connect();
    const info = this.bridge.serverInfo;
    if (!this.bridge.connected) {
      // The resolver found nothing to spawn or the child died: the panel needs a code, not a log line.
      this.failure = { code: 'MCP_SPAWN_FAILED', message: 'Không khởi động được MCP server của Roblox Studio.' };
      this.log.push('MCP connection failed; staying disconnected');
      return;
    }
    // Never `MCP connected` on its own: name the source the resolver actually spawned.
    this.log.push(info.source === 'none'
      ? 'MCP connected but the server could not be identified'
      : `MCP connected from ${info.source}${info.path ? `: ${basenameOf(info.path)}` : ''}`);
  }

  /** Bootstrap shutdown owns this: quitting the app must not leave the Studio MCP child alive. */
  async close(): Promise<void> {
    this.studioCache = null;
    this.studioIdAt = 0;
    this.publishedToolCount = 0;
    await this.bridge.close();
    this.log.push('MCP closed');
  }

  /**
   * The stored override read through the SAME allowlist the route wrote it with, so this class can
   * never advertise (or log) a `settings` source it would refuse to spawn.
   */
  private validatedOverride(): string | null {
    const override = this.readPathOverride();
    if (override === null || override === undefined) return null;
    if (isAllowedMcpPath(override)) return override;
    // Once per distinct value: a stored path that fails the rules is a configuration problem, and
    // repeating the complaint would bury the lifecycle log it sits in.
    if (this.rejectedOverride !== override) {
      this.rejectedOverride = override;
      this.log.push(`MCP override ignored (failed the path rules): ${basenameOf(override)}`);
    }
    return null;
  }
}

export function createMcpGateway(
  bridge: McpBridge,
  options: { log?: McpLog; pathOverride?: () => string | null } = {},
): ServiceMcpGateway {
  return new ServiceMcpGateway(bridge, options);
}

/** Gateways that keep their own lifecycle log; `ServiceMcpGateway` is one, a bare stub need not be. */
export interface McpLogGateway extends McpGateway {
  readonly logs: string[];
}

/**
 * The `GET /api/mcp/status` body. `McpGateway` (Task 14) has no log member, so the log is read
 * structurally: a gateway without one reports an empty list instead of the route guessing.
 */
export function mcpStatusOf(gateway: McpGateway): McpStatus {
  const logs = (gateway as Partial<McpLogGateway>).logs;
  return {
    connected: gateway.connected,
    studioLinked: gateway.studioLinked,
    server: gateway.server,
    studio: gateway.studio ? { ...gateway.studio } : null,
    toolCount: gateway.toolCount,
    lastError: gateway.lastError ? { ...gateway.lastError } : null,
    logs: Array.isArray(logs) ? [...logs] : [],
  };
}
