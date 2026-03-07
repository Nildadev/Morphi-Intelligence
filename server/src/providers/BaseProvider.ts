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
    const builtInTools = [
      {
        name: 'create_task',
        description: 'Create or update a task to track progress. Use this to outline steps and mark them as complete.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The title of the task' },
            description: { type: 'string', description: 'Optional detailed description' },
            status: { type: 'string', enum: ['todo', 'done'], description: 'Current status of the task. Default is todo.' }
          },
          required: ['title']
        }
      },
      {
        name: 'lint_luau',
        description: 'Lint Luau code for common errors and style issues.',
        input_schema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'The Luau code to lint' }
          },
          required: ['code']
        }
      }
    ];

    try {
      const toolList = await mcpService.listTools();
      return [...builtInTools, ...(toolList.tools || [])];
    } catch (e) {
      return builtInTools;
    }
  }

  async executeTool(name: string, args: any): Promise<string> {
    if (name === 'create_task') {
      const statusText = args.status === 'done' ? 'completed' : 'created/updated';
      return `Task "${args.title}" ${statusText} successfully.`;
    }

    if (name === 'lint_luau') {
      const code = args.code || '';
      const issues: string[] = [];

      // 1. Check for deprecated wait()
      if (code.includes('wait(') && !code.includes('task.wait(')) {
        issues.push('⚠️ Use `task.wait()` instead of `wait()` for better performance.');
      }

      // 2. Check for missing local (vague but useful for simple assignments)
      const lines = code.split('\n');
      lines.forEach((line: string, i: number) => {
        const trimmed = line.trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(trimmed) && !trimmed.startsWith('local ')) {
          issues.push(`Line ${i + 1}: Global variable assignment detected or missing \`local\`.`);
        }
      });

      // 3. Basic Block matching (Count)
      const opens = (code.match(/\b(then|do|repeat|function)\b/g) || []).length;
      const closes = (code.match(/\b(end|until)\b/g) || []).length;
      if (opens !== closes) {
        issues.push(`❌ Block mismatch: Found ${opens} opening tags and ${closes} closing tags. Check your \`end\` keywords.`);
      }

      return issues.length > 0
        ? `Linter found the following issues:\n${issues.join('\n')}`
        : "✅ No major issues found by the basic linter. Code looks good!";
    }

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