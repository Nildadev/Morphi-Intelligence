import { BaseProvider } from './BaseProvider';
import { Model, Message, StreamChunk } from '../types/llm';
import OpenAI from 'openai';
import { runOpenAICompatibleChat } from './OpenAICompatibleMixin';

export class ProxyPalProvider extends BaseProvider {
  private baseUrl: string;

  constructor() {
    super('proxypal', 'ProxyPal (Local)', 'https://models.dev/logos/proxypal.svg');
    this.baseUrl = process.env.PROXYPAL_URL || 'http://localhost:8317/v1';
    this.apiKey = process.env.PROXYPAL_API_KEY || 'proxypal-local';
  }

  async getModels(): Promise<Model[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.baseUrl}/models`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
        },
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        console.warn('[ProxyPal] 401 Unauthorized — update API key in Settings.');
        return [];
      }
      if (!response.ok) {
        console.warn(`[ProxyPal] Server error: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json();
      const models = (data.data || []).map((m: any) => ({
        id: `proxypal/${m.id}`,
        name: m.id,
        provider: this.id,
        providerLabel: this.name,
        logo: this.logo,
        description: `Local • ${(m.context_length || 4096).toLocaleString()} ctx`,
        context: m.context_length || 4096,
      }));

      console.log(`[ProxyPal] Found ${models.length} local model(s).`);
      return models;
    } catch {
      // Offline or unreachable — silently return empty
      return [];
    }
  }

  async *chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk> {
    const actualModelId = modelId.replace('proxypal/', '');
    const client = new OpenAI({
      apiKey: this.apiKey || 'no-key',
      baseURL: this.baseUrl,
    });

    yield* runOpenAICompatibleChat(this, client, messages, actualModelId, options);
  }
}
