import { LLMProvider, Message, Model, StreamChunk } from '../types/llm';
import { BaseProvider } from '../providers/BaseProvider';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { GeminiProvider } from '../providers/GeminiProvider';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { ProxyPalProvider } from '../providers/ProxyPalProvider';
import { ModelRegistry } from './ModelRegistry';

class LLMManager {
  private providers: Map<string, BaseProvider> = new Map();

  // model-id → provider-id lookup (populated lazily in getModels)
  private modelProviderMap: Map<string, string> = new Map();
  private cachedModels: Model[] = [];
  private lastFetch: number = 0;
  private readonly CACHE_TTL = 3600 * 1000; // 1 hour

  constructor() {
    this.registerProvider('openai', new OpenAIProvider());
    this.registerProvider('google', new GeminiProvider());
    this.registerProvider('openrouter', new OpenRouterProvider());
    this.registerProvider('proxypal', new ProxyPalProvider());
  }

  registerProvider(id: string, provider: BaseProvider) {
    this.providers.set(id, provider);
  }

  updateKey(providerId: string, apiKey: string) {
    const provider = this.providers.get(providerId);
    if (provider) {
      provider.configure(apiKey);
    } else {
      // For any provider not natively implemented, we just store it in env/state
      // so that generic model fetching from ModelRegistry can potentially use it.
      // In a real app, you might want to persist this to a DB/config file.
      console.log(`[LLMManager] Key updated for dynamic provider: ${providerId}`);
    }
    // Invalidate cache so updated key is used on next getModels() call
    this.lastFetch = 0;
    this.cachedModels = [];
    this.modelProviderMap.clear();
  }

  async getProviders(): Promise<any[]> {
    const native = Array.from(this.providers.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      logo: (p as any).logo || `https://models.dev/logos/${id}.svg`,
      native: true
    }));

    const registry = await ModelRegistry.getProviders();
    const nativeIds = new Set(native.map(n => n.id));

    return [
      ...native,
      ...registry.filter(r => !nativeIds.has(r.id)).map(r => ({ ...r, native: false }))
    ];
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  async getModels(forceRefresh = false): Promise<Model[]> {
    const cacheValid =
      !forceRefresh &&
      this.cachedModels.length > 0 &&
      Date.now() - this.lastFetch < this.CACHE_TTL;

    if (cacheValid) return this.cachedModels;

    const results = await Promise.allSettled(
      Array.from(this.providers.values()).map((p) => p.getModels())
    );

    const models: Model[] = [];
    const newMap = new Map<string, string>();

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const model of result.value) {
          models.push(model);
          newMap.set(model.id, model.provider);
        }
      }
    }

    // Mix in models from models.dev for discovered providers
    try {
      const registryModels = await ModelRegistry.getModels(forceRefresh);
      for (const m of registryModels) {
        // Only add if not already present from a native provider's direct fetch
        if (!newMap.has(m.id)) {
          models.push(m);
          newMap.set(m.id, m.provider);
        }
      }
    } catch (e) {
      console.warn('[LLMManager] Registry models mix-in failed:', e);
    }

    this.cachedModels = models;
    this.modelProviderMap = newMap;
    this.lastFetch = Date.now();
    return models;
  }

  /**
   * Resolve provider for a model ID.
   * Priority:
   *  1. Exact match in modelProviderMap (populated by getModels)
   *  2. Prefix heuristics as fast fallback (handles pre-cache state)
   */
  private resolveProviderId(modelId: string): string | undefined {
    // 1. Exact map lookup
    const fromMap = this.modelProviderMap.get(modelId);
    if (fromMap) return fromMap;

    // 2. Prefix heuristics
    if (modelId.startsWith('gemini-')) return 'google';
    if (modelId.startsWith('gpt-') ||
      modelId.startsWith('o1') ||
      modelId.startsWith('o3') ||
      modelId.startsWith('o4')) return 'openai';
    if (modelId.startsWith('openrouter/')) return 'openrouter';
    if (modelId.startsWith('proxypal/')) return 'proxypal';

    return undefined;
  }

  async *chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk> {
    // Ensure model map is populated (load from cache if available)
    if (this.modelProviderMap.size === 0) {
      await this.getModels();
    }

    const providerId = this.resolveProviderId(modelId);
    if (!providerId) {
      yield { type: 'error', content: `No provider found for model "${modelId}". Please check Settings.` };
      return;
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      yield { type: 'error', content: `Provider "${providerId}" is not registered.` };
      return;
    }

    yield* provider.chat(messages, modelId, options);
  }
}

export const llmManager = new LLMManager();
