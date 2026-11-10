import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMcpGateway, mcpStatusOf, type McpBridge } from './serviceGateway';
import type { McpSource } from '../tools/types';

class Bridge implements McpBridge {
  connected = false;
  studioLinked = false;
  serverInfo: { source: McpSource; path: string | null; version: string | null } = {
    source: 'none', path: null, version: null,
  };
  close = vi.fn(async () => { this.connected = false; this.studioLinked = false; });
  connect = vi.fn(async () => { this.connected = true; });
  listTools = vi.fn(async () => ({ tools: [] }));
  callTool = vi.fn(async () => ({ content: [] }));
}

describe('Task 31 gateway lifecycle', () => {
  it('close() releases the Studio MCP child and is observable in the log', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);
    await gateway.close();

    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(gateway.logs.some((line) => line.includes('MCP closed'))).toBe(true);
  });

  it('status reports the identity the bridge resolved, not a setting', () => {
    const bridge = new Bridge();
    bridge.serverInfo = { source: 'studio-builtin', path: 'C:/Roblox/StudioMCP.exe', version: '1.0.0' };
    bridge.connected = true;
    bridge.studioLinked = true;

    const status = mcpStatusOf(createMcpGateway(bridge));
    expect(status.server).toEqual({ source: 'studio-builtin', path: 'C:/Roblox/StudioMCP.exe', version: '1.0.0' });
    expect(status.connected).toBe(true);
    expect(status.studioLinked).toBe(true);
  });

  it('a cold boot honestly reports none/null/null', () => {
    expect(mcpStatusOf(createMcpGateway(new Bridge())).server).toEqual({ source: 'none', path: null, version: null });
  });

  it('normalises an MCP screenshot data URL before handing the pixels to the model', async () => {
    const bridge = new Bridge();
    bridge.listTools = vi.fn(async () => ({
      tools: [{
        name: 'screen_capture',
        description: 'Capture the Studio viewport',
        inputSchema: { type: 'object', properties: {}, required: ['studio_id'] },
      }],
    }));
    bridge.callTool = vi.fn(async (name: string) => name === 'list_roblox_studios'
      ? { content: [{ type: 'text', text: JSON.stringify({ studios: [{ id: 'studio-1', name: 'Place1' }] }) }] }
      : {
        content: [{
          type: 'image',
          mimeType: 'IMAGE/PNG',
          data: 'data:image/png;base64,aGVsbG8=',
        }],
      });
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    const result = await gateway.callTool('studio.screen_capture', {}, new AbortController().signal);

    expect(result).toMatchObject({
      images: [{ mime: 'image/png', data: 'aGVsbG8=' }],
    });
    expect((result as { text?: string }).text).toContain('[Ảnh IMAGE/PNG,');
  });
});

/**
 * Step 4 guard: the forbidden third-party bridge must never come back. Lockfiles and production
 * source are scanned; plan/spec/SDD history files are deliberately excluded (they document why).
 */
describe('no third-party MCP bridge', () => {
  const root = fs.existsSync(path.join(process.cwd(), 'server/src/services/McpService.ts'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');

  it('McpService resolves the official server and never references npx or the legacy package', () => {
    const source = fs.readFileSync(path.join(root, 'server/src/services/McpService.ts'), 'utf8');
    expect(source).toContain('resolveOfficialMcpServer');
    expect(source).not.toMatch(/robloxstudio-mcp|where npx|npx\.cmd/);
  });

  it('no lockfile resolves the legacy package', () => {
    for (const file of ['package-lock.json', 'server/package-lock.json', 'client/package-lock.json']) {
      const target = path.join(root, file);
      if (!fs.existsSync(target)) continue;
      expect(fs.readFileSync(target, 'utf8'), file).not.toContain('robloxstudio-mcp');
    }
  });
});
