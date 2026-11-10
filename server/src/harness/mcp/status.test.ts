import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../shared/types';
import { createMcpGateway, mcpStatusOf, type McpBridge } from './serviceGateway';

/**
 * Task 31C Step 1 + Step 3. The panel may only print what the server can prove: the resolved
 * executable, the version from `initialize`, the studio it actually resolved, the tool count after
 * the `studio.*` pass, and the last failure code. These tests drive the gateway through the same
 * states the UI reads, so a field that is missing here is a field the panel cannot show.
 */

const captureSchema: JsonSchema = {
  type: 'object',
  properties: { capture_id: { type: 'string' }, studio_id: { type: 'string' } },
  required: ['capture_id', 'studio_id'],
  additionalProperties: false,
};

class Bridge implements McpBridge {
  connected = true;
  studioLinked = true;
  serverInfo = { source: 'studio-builtin' as const, path: 'C:/Roblox/mcp.bat', version: '1.0.0' };
  studios: Array<{ id: string; name: string }> = [{ id: 'dec497bc-1111', name: 'Place1' }];
  /** Set by a test to make the next non-enumerator call fail with a specific wire error. */
  failure: unknown = null;
  connects = 0;

  async connect(): Promise<void> {
    this.connects += 1;
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<{ tools?: unknown }> {
    return {
      tools: [
        { name: 'screen_capture', description: 'Capture', inputSchema: captureSchema },
        { name: 'list_roblox_studios', description: 'List', inputSchema: { type: 'object', properties: {} } },
      ],
    };
  }

  async callTool(name: string): Promise<unknown> {
    if (name === 'list_roblox_studios') {
      return { content: [{ type: 'text', text: JSON.stringify({ studios: this.studios }) }] };
    }
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
    // Studio closed: the official proxy answers -32603 for every place-bound call.
    if (this.studios.length === 0) throw wireError(-32603, 'Studio is not connected');
    return { content: [{ type: 'text', text: `ran ${name}` }] };
  }
}

const wireError = (code: number, message: string): Error => Object.assign(new Error(message), { code });

describe('ServiceMcpGateway — status truthfulness', () => {
  it('reports the resolved studio, the tool count and no error after a successful call', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);

    await gateway.listTools();
    await gateway.callTool('studio.screen_capture', { capture_id: 'a' });

    const status = mcpStatusOf(gateway);
    expect(status.studio).toEqual({ id: 'dec497bc-1111', name: 'Place1' });
    expect(status.toolCount).toBe(2);
    expect(status.lastError).toBeNull();
    expect(status.server).toEqual({ source: 'studio-builtin', path: 'C:/Roblox/mcp.bat', version: '1.0.0' });
  });

  it('resolves the place during listTools, so the panel can name it before any tool call', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);

    await gateway.listTools();

    expect(mcpStatusOf(gateway).studio).toEqual({ id: 'dec497bc-1111', name: 'Place1' });
    expect(mcpStatusOf(gateway).studioLinked).toBe(true);
  });

  it('reports no Studio at listing time without inventing an error the user never caused', async () => {
    const bridge = new Bridge();
    bridge.studios = [];
    const gateway = createMcpGateway(bridge);

    await gateway.listTools();

    const status = mcpStatusOf(gateway);
    expect(status.studio).toBeNull();
    expect(status.studioLinked).toBe(false);
    // Nothing the user did failed: the badge is enough, no error row.
    expect(status.lastError).toBeNull();
  });

  it('keeps a nameless place nameless instead of passing the GUID off as its name', async () => {
    const bridge = new Bridge();
    // Live Studio 1.0.0 answers `{"studios":[{"id":"...","name":null}]}`: no name is not a name.
    bridge.studios = [{ id: '573d26fa-7dbb', name: null as unknown as string }];
    const gateway = createMcpGateway(bridge);

    await gateway.listTools();

    expect(mcpStatusOf(gateway).studio).toEqual({ id: '573d26fa-7dbb', name: null });
  });

  it('does not blame the place for a bad-argument error', async () => {
    const bridge = new Bridge();
    bridge.failure = Object.assign(new Error('Missing required argument: capture_id'), { code: -32602 });
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await expect(gateway.callTool('studio.screen_capture', {})).rejects.toThrow();

    const status = mcpStatusOf(gateway);
    // The place is open; the model just forgot an argument. Clearing the badge here is a lie.
    expect(status.studioLinked).toBe(true);
    expect(status.studio).toEqual({ id: 'dec497bc-1111', name: 'Place1' });
    expect(status.lastError?.code).toBe('MCP_TOOL_FAILED');
  });

  it('has no studio and no tool count before the first listing', () => {
    const gateway = createMcpGateway(new Bridge());

    const status = mcpStatusOf(gateway);
    expect(status.studio).toBeNull();
    expect(status.toolCount).toBe(0);
    expect(status.lastError).toBeNull();
  });

  it('records STUDIO_NOT_CONNECTED and drops the Studio badge when no place is open', async () => {
    const bridge = new Bridge();
    bridge.studios = [];
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'a' })).rejects.toThrow();

    const status = mcpStatusOf(gateway);
    expect(status.lastError?.code).toBe('STUDIO_NOT_CONNECTED');
    // The child process is still alive, but the place is gone: the Studio row must say so.
    expect(status.studioLinked).toBe(false);
    expect(status.studio).toBeNull();
  });

  it('records MULTIPLE_STUDIOS with every place named, never a guess', async () => {
    const bridge = new Bridge();
    bridge.studios = [
      { id: 'aaa', name: 'Place A' },
      { id: 'bbb', name: 'Place B' },
    ];
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'a' })).rejects.toThrow();

    const status = mcpStatusOf(gateway);
    expect(status.lastError?.code).toBe('MULTIPLE_STUDIOS');
    expect(status.lastError?.message).toContain('Place A');
    expect(status.lastError?.message).toContain('Place B');
  });

  it('maps the SDK request timeout to MCP_TOOL_TIMEOUT instead of a generic failure', async () => {
    const bridge = new Bridge();
    bridge.failure = wireError(-32001, 'Request timed out');
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'a' })).rejects.toThrow();

    expect(mcpStatusOf(gateway).lastError?.code).toBe('MCP_TOOL_TIMEOUT');
  });

  it('maps -32603 "proxy is out of date" to STUDIO_RESTART_REQUIRED, whose fix is restarting Studio', async () => {
    const bridge = new Bridge();
    bridge.failure = wireError(-32603, 'Client proxy is out of date, restart to update');
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'a' })).rejects.toThrow();

    expect(mcpStatusOf(gateway).lastError?.code).toBe('STUDIO_RESTART_REQUIRED');
  });

  it('clears the last error on the next successful call', async () => {
    const bridge = new Bridge();
    bridge.failure = wireError(-32603, 'Client proxy is out of date, restart to update');
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();
    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'a' })).rejects.toThrow();
    expect(mcpStatusOf(gateway).lastError).not.toBeNull();

    await gateway.callTool('studio.screen_capture', { capture_id: 'b' });

    expect(mcpStatusOf(gateway).lastError).toBeNull();
    expect(mcpStatusOf(gateway).studioLinked).toBe(true);
  });
});

describe('ServiceMcpGateway — connection recovery', () => {
  it('reports MCP_SPAWN_FAILED when a reconnect cannot start the official server', async () => {
    const bridge = new Bridge();
    bridge.connected = false;
    bridge.studioLinked = false;
    const gateway = createMcpGateway(bridge);
    // A bridge whose connect() never succeeds is what a machine without Studio looks like.
    bridge.connect = async () => { bridge.connects += 1; };

    await gateway.reconnect();

    const status = mcpStatusOf(gateway);
    expect(status.connected).toBe(false);
    expect(status.lastError?.code).toBe('MCP_SPAWN_FAILED');
    expect(status.toolCount).toBe(0);
  });

  it('restores a callable tool list across a Studio close → reopen cycle without a Morphi restart', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();
    await gateway.callTool('studio.screen_capture', { capture_id: 'a' });

    // Studio closes: the enumerator now answers with an empty list and calls fail.
    bridge.studios = [];
    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'b' })).rejects.toThrow();
    expect(mcpStatusOf(gateway).studioLinked).toBe(false);

    // Studio reopens with the same place; a reconnect must make the tools callable again.
    bridge.studios = [{ id: 'dec497bc-1111', name: 'Place1' }];
    await gateway.reconnect();
    await gateway.listTools();
    await gateway.callTool('studio.screen_capture', { capture_id: 'c' });

    const status = mcpStatusOf(gateway);
    expect(status.connected).toBe(true);
    expect(status.studioLinked).toBe(true);
    expect(status.studio).toEqual({ id: 'dec497bc-1111', name: 'Place1' });
    expect(status.toolCount).toBe(2);
    expect(status.lastError).toBeNull();
  });
});
