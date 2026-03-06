import { BaseProvider } from './BaseProvider';
import { Model, Message, StreamChunk } from '../types/llm';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SYSTEM_PROMPT } from '../services/SystemPrompt';

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

    // Fallback: Fetch from OpenRouter's public API (no key needed)
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models');
      if (!response.ok) return [];

      const data = await response.json();
      return (data.data || [])
        .filter((m: any) => m.id.startsWith('google/'))
        .map((m: any) => ({
          id: m.id.replace('google/', ''), // Keep raw ID for GeminiProvider
          name: m.name.replace('Google: ', ''),
          provider: this.id,
          providerLabel: this.name,
          logo: this.logo,
          description: m.description || 'Google Gemini Model (via public metadata)',
          context: m.context_length,
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
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        }
      });

      // Build initial history
      const history = [
        { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
        { role: 'model', parts: [{ text: "Understood. I am Morphi AI, ready to assist with your Roblox project." }] },
        ...messages.slice(0, -1).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }))
      ];

      const chat = model.startChat({ history });
      let currentInput: any = messages[messages.length - 1].content;
      let shouldContinue = true;

      while (shouldContinue) {
        shouldContinue = false;
        const result = await chat.sendMessageStream(currentInput);

        for await (const chunk of result.stream) {
          // Check for text
          try {
            const text = chunk.text();
            if (text) yield { type: 'content', content: text };
          } catch (e) {
            // chunk.text() throws if it only contains function calls
          }

          // Check for function calls
          const calls = chunk.functionCalls();
          if (calls && calls.length > 0) {
            const functionResponses = [];
            for (const call of calls) {
              // Notify frontend
              yield { type: 'call', call: { name: call.name, args: call.args } };

              const toolResult = await this.executeTool(call.name, call.args);

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