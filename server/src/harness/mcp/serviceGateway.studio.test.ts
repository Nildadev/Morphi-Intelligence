import { describe, expect, it, vi } from 'vitest';
import type { JsonSchema } from '../shared/types';
import { createMcpGateway, type McpBridge } from './serviceGateway';
import { StudioContextError } from './studioContext';

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
  calls: Array<{ name: string; args: unknown; signal?: AbortSignal }> = [];
  studios: Array<{ id: string; name: string }> = [{ id: 'dec497bc', name: 'Place1' }];
  failNext = false;
  /** Mirrors the live `screen_capture` shape: an image block, no text block. */
  imageResult = false;
  /** A text block and an image block in the same result. */
  mixedResult = false;

  async connect(): Promise<void> { /* inert */ }
  async close(): Promise<void> { this.connected = false; }

  async listTools(): Promise<{ tools?: unknown }> {
    return {
      tools: [
        { name: 'screen_capture', description: 'Capture', inputSchema: captureSchema },
        { name: 'list_roblox_studios', description: 'List', inputSchema: { type: 'object', properties: {} } },
      ],
    };
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ name, args, signal });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Studio closed');
    }
    if (name === 'list_roblox_studios') {
      // Real MCP shape: content blocks, not a bare string. This is what the first live run hit.
      return { content: [{ type: 'text', text: JSON.stringify({ studios: this.studios }) }] };
    }
    if (this.imageResult) {
      return { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'A'.repeat(218_520) }] };
    }
    if (this.mixedResult) {
      return { content: [{ type: 'text', text: 'captured' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
    }
    return { content: [{ type: 'text', text: `ran ${name}` }] };
  }
}

describe('ServiceMcpGateway — Studio tool surface', () => {
  it('publishes studio.* names and removes studio_id from the advertised schema', async () => {
    const gateway = createMcpGateway(new Bridge());
    const schemas = await gateway.listTools();

    expect(schemas.map((schema) => schema.name)).toEqual(['studio.screen_capture', 'studio.list_roblox_studios']);
    const capture = schemas[0].parameters as JsonSchema;
    expect(capture.properties?.studio_id).toBeUndefined();
    expect(capture.required).toEqual(['capture_id']);
  });

  it('injects the resolved studio_id into the server call, without asking the model', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();
    const signal = new AbortController().signal;

    await gateway.callTool('studio.screen_capture', { capture_id: 'a' }, signal);

    const call = bridge.calls.find((entry) => entry.name === 'screen_capture');
    expect(call?.args).toEqual({ capture_id: 'a', studio_id: 'dec497bc' });
    // Task 31B Step 3: the turn's signal reaches the MCP request.
    expect(call?.signal).toBe(signal);
  });

  it('returns the image pixels beside a short text note for an image-only result', async () => {
    const bridge = new Bridge();
    bridge.imageResult = true;
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    // Live `screen_capture` answers with ONE image block (image/jpeg, 160 KB) and no text at all.
    const result = await gateway.callTool('studio.screen_capture', { capture_id: 'Morphi_1' }) as {
      text: string;
      images: Array<{ mime: string; data: string }>;
    };

    // The pixels ride to vision models out-of-band; the durable text stays a short note.
    expect(result.images).toEqual([{ mime: 'image/jpeg', data: 'A'.repeat(218_520) }]);
    expect(result.text).toContain('image/jpeg');
    expect(result.text).toContain('KB');
    expect(result.text).not.toContain('chưa gửi được');
    expect(result.text.length).toBeLessThan(500);
  });

  it('keeps the text block and carries the image when a result has both', async () => {
    const bridge = new Bridge();
    bridge.mixedResult = true;
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    const result = await gateway.callTool('studio.screen_capture', { capture_id: 'a' }) as {
      text: string;
      images: Array<{ mime: string; data: string }>;
    };

    expect(result.text).toContain('captured');
    expect(result.images).toEqual([{ mime: 'image/png', data: 'aGVsbG8=' }]);
  });

  it('does not inject studio_id into the enumerator itself', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await gateway.callTool('studio.list_roblox_studios', {});

    const call = bridge.calls.find((entry) => entry.name === 'list_roblox_studios');
    expect(call?.args).toEqual({});
  });

  it('caches the id across calls and re-reads it after a failure', async () => {
    const bridge = new Bridge();
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    await gateway.callTool('studio.screen_capture', { capture_id: 'a' });
    await gateway.callTool('studio.screen_capture', { capture_id: 'b' });
    expect(bridge.calls.filter((entry) => entry.name === 'list_roblox_studios')).toHaveLength(1);

    bridge.failNext = true;
    await expect(gateway.callTool('studio.screen_capture', { capture_id: 'c' })).rejects.toThrow('Studio closed');
    await gateway.callTool('studio.screen_capture', { capture_id: 'd' });
    expect(bridge.calls.filter((entry) => entry.name === 'list_roblox_studios')).toHaveLength(2);
  });

  it('refuses to guess when several studios are connected', async () => {
    const bridge = new Bridge();
    bridge.studios = [{ id: 'a', name: 'Place1' }, { id: 'b', name: 'Place2' }];
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    const error = await gateway.callTool('studio.screen_capture', { capture_id: 'a' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StudioContextError);
    expect((error as StudioContextError).code).toBe('MULTIPLE_STUDIOS');
  });

  it('reports STUDIO_NOT_CONNECTED when Studio is closed', async () => {
    const bridge = new Bridge();
    bridge.studios = [];
    const gateway = createMcpGateway(bridge);
    await gateway.listTools();

    const error = await gateway.callTool('studio.screen_capture', { capture_id: 'a' }).catch((caught: unknown) => caught);
    expect((error as StudioContextError).code).toBe('STUDIO_NOT_CONNECTED');
  });
});
