import type { ToolSchema } from '../llm/types';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, BUILTIN_TOOLS, MCP_JOB_TIMEOUT_MS, MCP_TOOL_TIMEOUT_MS } from './registry';
import type { McpGateway, McpSource, ToolContext, ToolDefinition } from './types';

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: overrides.name ?? 'sample',
    description: 'A sample tool.',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => ({ echo: args }),
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Sample', risk: 'low' },
    ...overrides,
  };
}

function mcpSchema(name: string): ToolSchema {
  return { name, description: `MCP ${name}`, parameters: { type: 'object', properties: { q: { type: 'string' } } } };
}

class StubGateway implements McpGateway {
  readonly connected = true;
  readonly studioLinked = true;
  readonly server: { source: McpSource; path: string | null; version: string | null } = {
    source: 'studio-builtin',
    path: null,
    version: '1.8.0',
  };
  tools: ToolSchema[] = [];
  failList = false;
  calls: { name: string; args: unknown; signal?: AbortSignal }[] = [];
  reconnects = 0;

  async listTools(): Promise<ToolSchema[]> {
    if (this.failList) throw new Error('gateway closed');
    return this.tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ name, args, signal });
    return { from: 'mcp', name, args };
  }

  async reconnect(): Promise<void> {
    this.reconnects += 1;
  }

  async close(): Promise<void> {
    // Test seam for the Task 31 shutdown contract.
  }
}

function stubContext(mcp: McpGateway): ToolContext {
  const durable: unknown[] = [];
  return {
    sessionId: 's1',
    turnId: 't1',
    stepId: 'st1',
    callId: 'c1',
    signal: new AbortController().signal,
    emit: { durable: (event) => durable.push(event), live: () => undefined },
    mcp,
  };
}

describe('ToolRegistry built-ins', () => {
  it('starts with the built-in tools and lists them in registration order', () => {
    const registry = new ToolRegistry();

    expect(registry.list().map((entry) => entry.name)).toEqual([
      'todo_write', 'lint_luau', 'web_fetch', 'web_search',
    ]);
    expect(BUILTIN_TOOLS.map((entry) => entry.name)).toEqual([
      'todo_write',
      'lint_luau',
      'web_fetch',
      'web_search',
    ]);
  });

  it('accepts an explicit tool list for callers that do not want built-ins', () => {
    const registry = new ToolRegistry([tool({ name: 'custom' })]);

    expect(registry.list().map((entry) => entry.name)).toEqual(['custom']);
    expect(registry.has('todo_write')).toBe(false);
  });

  it('registers, replaces and looks up tools by name', () => {
    const registry = new ToolRegistry([]);
    const first = tool({ name: 'a' });
    const second = tool({ name: 'a', description: 'Replaced.' });

    registry.register(first);
    expect(registry.get('a')).toBe(first);
    expect(registry.has('a')).toBe(true);

    registry.register(second);
    expect(registry.get('a')?.description).toBe('Replaced.');
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
  });

  it('normalises an auto + high risk definition to ask on register', () => {
    const registry = new ToolRegistry([]);
    const deploy = tool({ name: 'deploy', approval: 'auto', presentation: { label: 'Deploy', risk: 'high' } });

    registry.register(deploy);

    const stored = registry.get('deploy');
    expect(stored?.approval).toBe('ask');
    expect(stored?.presentation).toEqual({ label: 'Deploy', risk: 'high' });
    expect(stored?.description).toBe(deploy.description);
    expect(deploy.approval).toBe('auto');
  });

  it('leaves every other approval mode untouched', () => {
    const registry = new ToolRegistry([]);
    const readOnly = tool({ name: 'script_read', approval: 'auto', presentation: { label: 'Read', risk: 'low' } });
    const askOnce = tool({ name: 'run_code', approval: 'ask-once', presentation: { label: 'Run', risk: 'high' } });

    registry.register(readOnly);
    registry.register(askOnce);

    expect(registry.get('script_read')).toBe(readOnly);
    expect(registry.get('run_code')).toBe(askOnce);
    expect(registry.get('script_read')?.approval).toBe('auto');
    expect(registry.get('run_code')?.approval).toBe('ask-once');
  });

  it('exposes only name, description and parameters to the model', () => {
    const registry = new ToolRegistry();

    const schemas = registry.schemas();

    expect(schemas).toEqual(BUILTIN_TOOLS.map((entry) => ({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
    })));
    expect(Object.keys(schemas[0]).sort()).toEqual(['description', 'name', 'parameters']);

    const highRisk = tool({ name: 'deploy', approval: 'auto', presentation: { label: 'Deploy', risk: 'high' } });
    registry.register(highRisk);
    expect(registry.schemas().map((schema) => schema.name)).toContain('deploy');
    expect(registry.get('deploy')?.approval).toBe('ask');
  });
});

describe('ToolRegistry syncMcp', () => {
  it('merges MCP tools under the studio namespace with policy from the explicit table', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('execute_luau'), mcpSchema('multi_edit')];
    const registry = new ToolRegistry();

    await registry.syncMcp(gateway);

    expect(registry.list().map((entry) => entry.name)).toEqual([
      'todo_write', 'lint_luau', 'web_fetch', 'web_search',
      'studio.execute_luau', 'studio.multi_edit',
    ]);
    for (const name of ['execute_luau', 'multi_edit']) {
      const merged = registry.get(`studio.${name}`);
      expect(merged).toBeDefined();
      expect(merged?.description).toBe(`MCP ${name}`);
      expect(merged?.parameters).toEqual(mcpSchema(name).parameters);
      expect(merged?.approval).toBe('ask');
      expect(merged?.timeoutMs).toBe(MCP_TOOL_TIMEOUT_MS);
    }
    expect(registry.get('studio.execute_luau')?.presentation).toEqual({ label: 'Chạy Luau', risk: 'high' });
    expect(registry.get('studio.multi_edit')?.presentation).toEqual({ label: 'Sửa nhiều đoạn script', risk: 'medium' });
  });

  it('marks read-only tools auto/low and mutating tools ask — explicitly, not by prefix', async () => {
    const gateway = new StubGateway();
    gateway.tools = [
      mcpSchema('get_console_output'),
      mcpSchema('script_read'),
      mcpSchema('script_grep'),
      mcpSchema('insert_asset'),
      mcpSchema('start_stop_play'),
    ];
    const registry = new ToolRegistry();

    await registry.syncMcp(gateway);

    for (const name of ['get_console_output', 'script_read', 'script_grep']) {
      expect(registry.get(`studio.${name}`)?.approval, name).toBe('auto');
      expect(registry.get(`studio.${name}`)?.presentation.risk, name).toBe('low');
    }
    expect(registry.get('studio.insert_asset')?.approval).toBe('ask');
    expect(registry.get('studio.start_stop_play')?.approval).toBe('ask');
  });

  it('gives wait_job_finished a budget that can outlast a generation', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('wait_job_finished')];
    const registry = new ToolRegistry();
    await registry.syncMcp(gateway);

    expect(registry.get('studio.wait_job_finished')?.timeoutMs).toBe(MCP_JOB_TIMEOUT_MS);
    expect(MCP_JOB_TIMEOUT_MS).toBeGreaterThan(MCP_TOOL_TIMEOUT_MS);
  });

  it('carries the per-tool output cap from the Studio policy table', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('search_game_tree'), mcpSchema('get_studio_state')];
    const registry = new ToolRegistry();

    await registry.syncMcp(gateway);

    // A 22 803-char tree must not be allowed to fill the window on a small model.
    expect(registry.get('studio.search_game_tree')?.maxOutputChars).toBe(8_000);
    expect(registry.get('studio.get_studio_state')?.maxOutputChars).toBeUndefined();
  });

  it('delegates execution to the synced gateway with the public name, args and signal', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('execute_luau')];
    const registry = new ToolRegistry();
    await registry.syncMcp(gateway);
    const decoy = new StubGateway();
    const context = stubContext(decoy);

    const result = await registry.get('studio.execute_luau')?.execute({ code: 'print(1)' }, context);

    expect(result).toEqual({ from: 'mcp', name: 'studio.execute_luau', args: { code: 'print(1)' } });
    expect(decoy.calls).toEqual([]);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].name).toBe('studio.execute_luau');
    expect(gateway.calls[0].args).toEqual({ code: 'print(1)' });
    expect(gateway.calls[0].signal).toBe(context.signal);
  });

  it('replaces the previous MCP set on the next sync and keeps built-ins', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('execute_luau'), mcpSchema('script_read')];
    const registry = new ToolRegistry();
    await registry.syncMcp(gateway);

    gateway.tools = [mcpSchema('get_console_output')];
    await registry.syncMcp(gateway);

    expect(registry.list().map((entry) => entry.name)).toEqual([
      'todo_write', 'lint_luau', 'web_fetch', 'web_search', 'studio.get_console_output',
    ]);
    expect(registry.get('studio.execute_luau')).toBeUndefined();
    expect(registry.get('studio.script_read')).toBeUndefined();
  });

  it('keeps the current tools and warns when the gateway cannot list', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('execute_luau')];
    const registry = new ToolRegistry();
    await registry.syncMcp(gateway);
    gateway.failList = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(registry.syncMcp(gateway)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('mcp');
    expect(registry.get('studio.execute_luau')).toBeDefined();
    warn.mockRestore();
  });

  it('is safe to call with a registry without built-ins', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('script_read')];
    const registry = new ToolRegistry([]);

    await registry.syncMcp(gateway);

    expect(registry.schemas()).toEqual([{
      name: 'studio.script_read',
      description: 'MCP script_read',
      parameters: gateway.tools[0].parameters,
    }]);
  });

  it('namespaces the server tool instead of overwriting a same-named built-in', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('todo_write')];
    const registry = new ToolRegistry();

    await registry.syncMcp(gateway);

    expect(registry.get('todo_write')).toBe(BUILTIN_TOOLS[0]);
    expect(registry.get('studio.todo_write')).toBeDefined();
    // 4 built-ins + the one MCP tool synced above.
    expect(registry.list()).toHaveLength(5);
  });

  it('drops a public name from the MCP collision set when it is registered explicitly', async () => {
    const gateway = new StubGateway();
    gateway.tools = [mcpSchema('multi_edit')];
    const registry = new ToolRegistry([]);
    await registry.syncMcp(gateway);
    const local = tool({ name: 'studio.multi_edit', description: 'Local multi edit.', approval: 'ask-once' });

    registry.register(local);
    expect(registry.get('studio.multi_edit')).toBe(local);

    await registry.syncMcp(gateway);

    expect(registry.get('studio.multi_edit')).toBe(local);
    expect(registry.get('studio.multi_edit')?.description).toBe('Local multi edit.');
    expect(registry.list()).toHaveLength(1);
  });
});
