import { Model, LLMProvider, Message, StreamChunk } from '../types/llm';
import { mcpService } from '../services/McpService';

export abstract class BaseProvider implements LLMProvider {
  id: string;
  name: string;
  apiKey: string;
  protected logo: string;

  constructor(id: string, name: string, logo: string) {
    this.id = id;
    this.name = name;
    this.logo = logo;
    this.apiKey = process.env[`${id.toUpperCase()}_API_KEY`] || '';
  }

  configure(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async getTools(): Promise<any[]> {
    try {
      const toolList = await mcpService.listTools();
      return toolList.tools || [];
    } catch (e) {
      // console.warn("Failed to fetch MCP tools (McpService might not be ready):", e);
      return [];
    }
  }

  async executeTool(name: string, args: any): Promise<string> {
    try {
      console.log(`[MCP] Executing tool: ${name}`, args);
      const result = await mcpService.callTool(name, args);
      
      // Format result for LLM consumption
      if (result.content && Array.isArray(result.content)) {
        return result.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      }
      return JSON.stringify(result);
    } catch (e: any) {
      console.error(`[MCP] Tool execution failed: ${e.message}`);
      return `Error executing tool ${name}: ${e.message}`;
    }
  }

  abstract getModels(): Promise<Model[]>;
  abstract chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk>;
}