import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveOfficialMcpServer } from '../harness/mcp/officialServer';
import type { McpSource } from '../harness/tools/types';
import { redact } from '../http/redact';

/**
 * Task 31 — the ONLY MCP bridge Morphi uses: Roblox's own Studio MCP server.
 *
 * Removed for good: the npm-based launcher and the third-party Studio bridge package (including
 * the extra HTTP ports it opened), plus stdout string-matching for the Studio link. The child is
 * resolved by
 * `resolveOfficialMcpServer` (shared allowlist + realpath containment) and launched by the Node
 * runtime already inside `utilityProcess` — no machine-wide Node install, no npm download.
 */
const LOG_LIMIT = 50;

interface ServerInfo {
  source: McpSource;
  path: string | null;
  version: string | null;
}

const NO_SERVER: ServerInfo = { source: 'none', path: null, version: null };

export interface McpServiceOptions {
  /** Live Settings row; re-read at every connect so a stored override never outlives validation. */
  pathOverride?: () => string | null;
  onLog?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export class McpService {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private isConnected = false;
  private isConnecting = false;
  private isStudioLinked = false;
  private server: ServerInfo = { ...NO_SERVER };
  private readonly lines: string[] = [];

  constructor(private readonly options: McpServiceOptions = {}) {}

  get connected(): boolean {
    return this.isConnected;
  }

  get studioLinked(): boolean {
    return this.isStudioLinked;
  }

  /** Identity comes from the MCP handshake, not from a log line or a stored setting. */
  get serverInfo(): ServerInfo {
    return { ...this.server };
  }

  get logs(): string[] {
    return [...this.lines];
  }

  private push(line: unknown): void {
    const message = redact(String(line ?? '').replace(/\s+/g, ' ').trim());
    if (!message) return;
    this.lines.push(message);
    if (this.lines.length > LOG_LIMIT) this.lines.shift();
    this.options.onLog?.(message);
  }

  async connect(): Promise<void> {
    if (this.isConnected || this.isConnecting) return;
    this.isConnecting = true;

    const spec = resolveOfficialMcpServer({
      env: this.options.env ?? process.env,
      platform: this.options.platform ?? process.platform,
      override: this.options.pathOverride?.() ?? null,
    });

    // No official server found is a normal cold-boot state, not an error: report it honestly in
    // Vietnamese and stay disconnected instead of spawning a third-party bridge.
    if (!spec) {
      this.server = { ...NO_SERVER };
      this.push('Không tìm thấy MCP server chính thức của Roblox Studio. Mở Roblox Studio, bật Assistant › Manage MCP Servers, hoặc khai đường dẫn trong Cài đặt.');
      this.isConnecting = false;
      return;
    }

    try {
      this.transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        // `shell: false` + argv array are enforced by the SDK; a .bat is passed as data to cmd.exe.
        stderr: 'pipe',
      });
      if (this.transport.stderr) {
        this.transport.stderr.on('data', (data: Buffer) => this.push(String(data)));
      }

      this.client = new Client(
        { name: 'Morphi-Backend', version: '1.1.0' },
        { capabilities: {} },
      );
      await this.client.connect(this.transport);

      const handshake = this.client.getServerVersion();
      this.server = { source: spec.source, path: spec.path, version: handshake?.version ?? null };
      this.isConnected = true;
      this.push(`MCP connected from ${spec.source}: ${handshake?.name ?? 'RobloxStudio'} ${handshake?.version ?? '(version unknown)'}`);

      // Studio link is derived from the protocol: the handshake can succeed while Studio itself is
      // closed, so only a successful tools/list proves the proxy reaches a live place.
      try {
        const tools = await this.listTools();
        this.isStudioLinked = true;
        this.push(`MCP ${tools?.tools?.length ?? 0} tool(s) available.`);
      } catch {
        this.isStudioLinked = false;
        this.push('MCP handshake ok but Studio is not linked yet.');
      }
    } catch (error) {
      this.push(`MCP connect failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.close();
    } finally {
      this.isConnecting = false;
    }
  }

  async reconnect(): Promise<void> {
    if (this.isConnected) return;
    await this.close();
    await this.connect();
  }

  async listTools(): Promise<ListToolsResult> {
    if (!this.isConnected || !this.client) throw new Error('MCP Client is not connected.');
    return await this.client.listTools();
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.isConnected || !this.client) throw new Error('MCP Client is not connected.');
    // Task 31B Step 3: the SDK aborts the in-flight JSON-RPC request when the turn's signal fires,
    // so Stop does not leave Studio executing a call nobody is waiting for.
    return await this.client.callTool(
      { name, arguments: args as Record<string, unknown> },
      undefined,
      signal ? { signal } : undefined,
    );
  }

  async close(): Promise<void> {
    try {
      if (this.transport) await this.transport.close();
    } catch { /* ignore close errors */ }
    this.isConnected = false;
    this.isConnecting = false;
    // A closed pipe has no link: without this reset a reconnect with Studio closed would keep
    // reporting studioLinked:true forever.
    this.isStudioLinked = false;
    this.server = { ...NO_SERVER };
    this.client = null;
    this.transport = null;
  }
}
