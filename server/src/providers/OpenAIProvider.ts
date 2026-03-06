import { BaseProvider } from './BaseProvider';
import { Model, Message, StreamChunk } from '../types/llm';
import OpenAI from 'openai';
import { runOpenAICompatibleChat } from './OpenAICompatibleMixin';

// Models we serve via the API (allow-list based IDs)
const ALLOWED_API_PREFIXES = ['gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4'];
const BLOCKED_SUFFIXES = ['instruct', 'vision', 'preview', 'search'];

export class OpenAIProvider extends BaseProvider {
  constructor() {
    super('openai', 'OpenAI', 'https://models.dev/logos/openai.svg');
  }

  async getModels(): Promise<Model[]> {
    if (this.apiKey) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
        });

        if (response.ok) {
          const data = await response.json();
          return (data.data || [])
            .filter((m: any) =>
              ALLOWED_API_PREFIXES.some((prefix) => m.id.startsWith(prefix)) &&
              !BLOCKED_SUFFIXES.some((suffix) => m.id.endsWith(suffix))
            )
            .map((m: any) => ({
              id: m.id,
              name: m.id,
              provider: this.id,
              providerLabel: this.name,
              logo: this.logo,
              description: `OpenAI • Released ${new Date(m.created * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}`,
            }));
        }
      } catch (err) {
        console.warn('[OpenAI] Failed to fetch models via official API:', err);
      }
    }

    // Fallback: Fetch from OpenRouter's public API (no key needed)
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models');
      if (!response.ok) return [];

      const data = await response.json();
      return (data.data || [])
        .filter((m: any) => m.id.startsWith('openai/'))
        .map((m: any) => ({
          id: m.id.replace('openai/', ''), // Keep it as raw ID for OpenAIProvider
          name: m.name.replace('OpenAI: ', ''),
          provider: this.id,
          providerLabel: this.name,
          logo: this.logo,
          description: m.description || 'OpenAI Model (via public metadata)',
          context: m.context_length,
        }));
    } catch {
      return [];
    }
  }

  async *chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk> {
    if (!this.apiKey) {
      yield { type: 'error', content: 'OpenAI API Key is missing. Go to Settings to add it.' };
      return;
    }

    const client = new OpenAI({ apiKey: this.apiKey });
    yield* runOpenAICompatibleChat(this, client, messages, modelId, options);
  }
}