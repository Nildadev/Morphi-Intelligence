import { BaseProvider } from './BaseProvider';
import { Model, Message, StreamChunk } from '../types/llm';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SYSTEM_PROMPT } from '../services/SystemPrompt';
import { ModelRegistry } from '../services/ModelRegistry';

export class GeminiProvider extends BaseProvider {
  constructor() {
    super('google', 'Google AI Studio', 'https://models.dev/logos/google.svg');
  }

  async getModels(): Promise<Model[]> {
    if (this.apiKey) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`);
        if (response.ok) {
          const data = await response.json();
          return (data.models || [])
            .filter((m: any) => m.name.includes('gemini') && m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => ({
              id: m.name.replace('models/', ''),
              name: m.displayName || m.name,
              provider: this.id,
              providerLabel: this.name,
              logo: this.logo,
              description: m.description,
              context: m.inputTokenLimit
            }));
        }
      } catch (error) {
        console.warn('[Gemini] Official API fetch failed, falling back to public list:', error);
      }
    }

    // Fallback: Fetch from models.dev (no key needed)
    try {
      const googleModels = await ModelRegistry.getModelsByProvider('google');
      return googleModels.map((m: any) => ({
        ...m,
        id: m.id.replace('google/', ''), // Keep raw ID for GeminiProvider
        provider: this.id,
        providerLabel: this.name,
      }));
    } catch {
      return [];
    }
  }

  async *chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk> {
    if (!this.apiKey) {
      yield { type: 'error', content: 'Gemini API Key is missing.' };
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(this.apiKey);

      const mcpTools = await this.getTools();
      const tools = mcpTools.length > 0 ? [{
        functionDeclarations: mcpTools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }))
      }] : undefined;

      const maxTokens = options?.extendedThinking ? 16384 : 4096;

      const model = genAI.getGenerativeModel({
        model: modelId,
        tools: tools as any,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        }
      });

      // Build initial history - pure and aligned with systemInstruction
      const history: any[] = [];

      for (const m of messages.slice(0, -1)) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts: any[] = [{ text: m.content || '' }];

        if (m.calls && m.calls.length > 0) {
          // Add tool calls
          for (const call of m.calls) {
            parts.push({
              functionCall: {
                name: call.name,
                args: call.args
              }
            });
          }
          history.push({ role, parts });

          // Add corresponding responses as a separate turn
          const responseParts = m.calls.map(call => ({
            functionResponse: {
              name: call.name,
              response: { content: call.result || "No result provided." }
            }
          }));
          history.push({ role: 'user', parts: responseParts });
        } else {
          history.push({ role, parts });
        }
      }

      const chat = model.startChat({ history });
      let currentInput: any = messages[messages.length - 1].content;
      let shouldContinue = true;

      while (shouldContinue) {
        shouldContinue = false;
        const result = await chat.sendMessageStream(currentInput);

        for await (const chunk of result.stream) {
          // Check for thinking/reasoning (Gemini 2.0 Thinking models)
          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if ((part as any).thought) {
                yield { type: 'thought', content: (part as any).text };
              }
            }
          }

          // Check for text content
          try {
            const text = chunk.text();
            if (text) yield { type: 'content', content: text };
          } catch (e) {
            // chunk.text() throws if it only contains function calls or only thought
          }

          // Check for function calls
          const calls = chunk.functionCalls();
          if (calls && calls.length > 0) {
            const functionResponses = [];
            for (const call of calls) {
              // Notify frontend
              yield { type: 'call', call: { name: call.name, args: call.args } };

              let toolResult = await this.executeTool(call.name, call.args);

              // Safety: Truncate extremely large tool results (e.g. 50k+ chars)
              if (toolResult.length > 50000) {
                toolResult = toolResult.substring(0, 50000) + "\n\n...(truncated due to size)...";
              }

              // Notify frontend with result
              yield { type: 'call', call: { name: call.name, args: call.args, result: toolResult } };

              functionResponses.push({
                functionResponse: {
                  name: call.name,
                  response: { content: toolResult }
                }
              });
            }
            // Prepare to send responses back in next iteration
            currentInput = functionResponses;
            shouldContinue = true;
          }
        }
      }
      yield { type: 'done' };
    } catch (error: any) {
      yield { type: 'error', content: error.message || 'Unknown Gemini Error' };
    }
  }
}