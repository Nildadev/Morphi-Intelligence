import { BaseProvider } from './BaseProvider';
import { Model, Message, StreamChunk } from '../types/llm';
import OpenAI from 'openai';
import { runOpenAICompatibleChat } from './OpenAICompatibleMixin';

export class OpenRouterProvider extends BaseProvider {
  constructor() {
    super('openrouter', 'OpenRouter', 'https://models.dev/logos/openrouter.svg');
  }

  async getModels(): Promise<Model[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) return [];

      const data = await response.json();
      return (data.data || []).map((m: any) => ({
        id: `openrouter/${m.id}`,
        name: m.name || m.id,
        provider: this.id,
        providerLabel: this.name,
        logo: m.architecture?.image ?? this.logo,
        description: m.description || `${m.context_length?.toLocaleString() ?? '?'}k context`,
        context: m.context_length,
      }));
    } catch (error) {
      console.error('[OpenRouter] Failed to fetch models:', error);
      return [];
    }
  }

  async *chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk> {
    if (!this.apiKey) {
      yield { type: 'error', content: 'OpenRouter API Key is missing. Go to Settings to add it.' };
      return;
    }

    const actualModelId = modelId.replace('openrouter/', '');
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://morphi.app',
        'X-Title': 'Morphi Intelligence',
      },
    });

    yield* runOpenAICompatibleChat(this, client, messages, actualModelId, options);
  }
}