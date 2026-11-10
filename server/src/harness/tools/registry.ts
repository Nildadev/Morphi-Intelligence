import type { ToolSchema } from '../llm/types';
import { mcpToolName, policyFor, serverToolName } from '../mcp/toolNaming';
import { lintLuauTool } from './builtin/lint';
import { todoTool } from './builtin/todo';
import { webFetchTool, webSearchTool } from './builtin/web';
import type { McpGateway, ToolDefinition } from './types';

export const MCP_TOOL_TIMEOUT_MS = 120_000;
/**
 * Task 31B Step 3: a generation job returns a jobId fast; `wait_job_finished` is the call that
 * actually waits for it. Giving it the generic 120 s budget would kill real generations.
 */
export const MCP_JOB_TIMEOUT_MS = 300_000;

export const BUILTIN_TOOLS: ToolDefinition[] = [todoTool, lintLuauTool, webFetchTool, webSearchTool];

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private mcpNames = new Set<string>();

  constructor(tools: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const tool of tools) this.register(tool);
  }

  /**
   * Register (or replace) a tool. `{ approval: 'auto', risk: 'high' }` is normalised to
   * `ask` so a definition cannot express "high risk, no approval" and disagree with
   * `ApprovalService`, which always asks for high risk.
   */
  register(tool: ToolDefinition): void {
    const definition =
      tool.approval === 'auto' && tool.presentation.risk === 'high'
        ? { ...tool, approval: 'ask' as const }
        : tool;
    this.tools.set(definition.name, definition);
    // An explicit registration wins over the MCP mirror of the same name, so drop it from
    // the collision set: the next syncMcp() must not overwrite the built-in/plugin tool.
    this.mcpNames.delete(definition.name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /**
   * Replace the MCP half of the registry with the gateway's current tools. Called when
   * the registry is built for a turn and again after a reconnect (Task 17). A listing
   * failure keeps the previous tools so a dropped link cannot empty the model's toolkit.
   */
  async syncMcp(gateway: McpGateway): Promise<void> {
    let schemas: ToolSchema[];
    try {
      schemas = await gateway.listTools();
    } catch (error) {
      console.warn('[harness] mcp tool sync failed:', error instanceof Error ? error.message : String(error));
      return;
    }

    const incoming = new Set(schemas.map((schema) => schema.name));
    for (const stale of [...this.mcpNames]) {
      if (!incoming.has(stale)) {
        this.tools.delete(stale);
        this.mcpNames.delete(stale);
      }
    }

    for (const schema of schemas) {
      // Task 31B Step 2: every MCP tool is published as `studio.<serverName>`, so a server-side
      // `subagent`/`skill` can never silently overwrite Morphi's own built-in of the same name.
      const publicName = mcpToolName(serverToolName(schema.name));
      if (this.tools.has(publicName) && !this.mcpNames.has(publicName)) continue;
      const serverName = serverToolName(publicName);
      // Step 7: explicit policy table, never a `get_`/`list_` prefix guess.
      const policy = policyFor(serverName);
      const definition: ToolDefinition = {
        name: publicName,
        description: schema.description,
        parameters: schema.parameters,
        approval: policy.approval,
        isConcurrencySafe: policy.risk === 'low',
        timeoutMs: serverName === 'wait_job_finished' ? MCP_JOB_TIMEOUT_MS : MCP_TOOL_TIMEOUT_MS,
        // Task 31C: a tool that measured a huge answer caps itself, independently of the window.
        ...(policy.maxOutputChars === undefined ? {} : { maxOutputChars: policy.maxOutputChars }),
        presentation: { label: policy.label, risk: policy.risk },
        // The gateway owns public→server translation and the `studio_id` injection.
        execute: (args, context) => gateway.callTool(publicName, args, context.signal),
      };
      this.tools.set(definition.name, definition);
      this.mcpNames.add(definition.name);
    }
  }
}
