import { OpenAICompatibleAdapter } from './openaiCompatible';
import type { LlmRequest, ModelInfo, ProviderAdapter, StreamEvent } from './types';

export interface ProviderConfig {
  baseUrl?: string;
  enabled?: boolean;
}

const DEFAULT_PRIORITY = ['google', 'openai', 'anthropic', 'openrouter', 'deepseek', 'deepseek-chat', 'groq', 'mistral', 'xai', 'cerebras', 'together', 'fireworks', 'perplexity', 'deepinfra', 'nvidia', 'kilo', 'custom'];

/** Ids removed from the lineup: a vaulted key or stored config must not resurrect their card. */
const RETIRED_PROVIDER_IDS = new Set(['proxypal']);

/** Providers usable without a credential — see `LlmRegistry.isConfigured`. */
export const KEYLESS_PROVIDER_IDS: ReadonlySet<string> = new Set(['deepseek-chat']);

/**
 * The one shape a `custom:<slug>` connector may have. Exported because the routes guard `baseUrl` on
 * it: 1.1.0 fixes the built-in endpoints, and a mirrored copy in two files is how they drift.
 */
export const CUSTOM_PROVIDER_ID = /^custom:[a-z0-9-]+$/;

/**
 * Numeric generation of a model id, used only to break context-window ties. Google still lists
 * `gemini-2.5-flash` for existing keys even when it answers 404 for new ones, and both generations
 * advertise the same 1M window — without this tie-break, auto kept choosing the retired model.
 * Ids without a version sort last (`gemini-flash-latest` is an alias, not a generation).
 */
function generationOf(id: string): [number, number] {
  const match = id.match(/(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [0, 0];
}

/** Highest context first, then newest generation; stable for equal models (provider API order). */
function newestFirst(a: ModelInfo, b: ModelInfo): number {
  const context = (b.context ?? 0) - (a.context ?? 0);
  if (context !== 0) return context;
  const [majorA, minorA] = generationOf(a.id);
  const [majorB, minorB] = generationOf(b.id);
  return majorB - majorA || minorB - minorA;
}

export class NoProviderError extends Error {
  readonly code = 'NO_PROVIDER';

  constructor(message = 'No usable provider is configured') {
    super(message);
    this.name = 'NoProviderError';
  }
}

export class LlmRegistry {
  private readonly adapters: ProviderAdapter[];
  private readonly priority: string[];
  private readonly credentials = new Map<string, string>();
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly models = new Map<string, ModelInfo[]>();

  constructor(adapters: ProviderAdapter[], priority: string[] = DEFAULT_PRIORITY) {
    this.adapters = [...adapters];
    this.priority = [...priority];
  }

  setCredentials(keys: Record<string, string>): void {
    for (const adapter of this.adapters) {
      const next = keys[adapter.id] ?? '';
      const previous = this.credentials.get(adapter.id) ?? '';
      adapter.setApiKey?.(next);
      if (previous !== next) this.models.delete(adapter.id);
    }

    this.credentials.clear();
    for (const [id, key] of Object.entries(keys)) {
      if (RETIRED_PROVIDER_IDS.has(id)) continue;
      this.credentials.set(id, key);
    }
  }

  setProviderConfig(id: string, config: ProviderConfig): void {
    if (RETIRED_PROVIDER_IDS.has(id)) return;
    const previous = this.configs.get(id) ?? {};
    const next: ProviderConfig = { ...previous };
    if (config.baseUrl !== undefined) next.baseUrl = config.baseUrl;
    if (config.enabled !== undefined) next.enabled = config.enabled;
    this.configs.set(id, next);

    if (config.baseUrl !== undefined) {
      this.adapters.find((adapter) => adapter.id === id)?.setBaseUrl?.(config.baseUrl);
      if (previous.baseUrl !== config.baseUrl) this.models.delete(id);
    }
  }

  addCustomProvider(providerId: string, baseUrl: string): void {
    if (!CUSTOM_PROVIDER_ID.test(providerId)) {
      throw new Error(`Invalid custom provider id: ${providerId}`);
    }

    const existing = this.adapters.find((adapter) => adapter.id === providerId);
    if (existing) {
      existing.setBaseUrl?.(baseUrl);
      this.models.delete(providerId);
      return;
    }

    const adapter = new OpenAICompatibleAdapter({ id: providerId, name: providerId, baseUrl });
    const key = this.credentials.get(providerId);
    if (key) adapter.setApiKey(key);
    this.adapters.push(adapter);
  }

  async refreshModels(): Promise<void> {
    for (const adapter of this.adapters) {
      if (!this.isConfigured(adapter.id) || !this.isEnabled(adapter.id)) continue;
      try {
        this.models.set(adapter.id, await adapter.listModels());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to refresh models for ${adapter.id}: ${message}`);
      }
    }
  }

  getModels(): ModelInfo[] {
    return this.usableAdapters().flatMap((adapter) => this.models.get(adapter.id) ?? []);
  }

  resolveAuto(lastModel?: string): ModelInfo | undefined {
    if (lastModel) {
      const previous = this.getModels().find((model) => model.id === lastModel);
      if (previous) return previous;
    }

    for (const adapter of this.usableAdapters()) {
      const candidates = (this.models.get(adapter.id) ?? []).filter((model) => model.supportsTools);
      if (candidates.length === 0) continue;
      return [...candidates].sort(newestFirst)[0];
    }

    return undefined;
  }

  resolve(modelSelection: string): { adapter: ProviderAdapter; model: ModelInfo } {
    const selection = (modelSelection ?? '').trim();

    if (selection && selection !== 'auto') {
      for (const adapter of this.usableAdapters()) {
        const model = (this.models.get(adapter.id) ?? []).find((entry) => entry.id === selection);
        if (model) return { adapter, model };
      }
    }

    const model = this.resolveAuto();
    if (!model) throw new NoProviderError();

    const adapter = this.adapters.find((entry) => entry.id === model.provider);
    if (!adapter) throw new NoProviderError(`No adapter found for provider ${model.provider}`);
    return { adapter, model };
  }

  stream(modelSelection: string, request: Omit<LlmRequest, 'model'>): AsyncIterable<StreamEvent> {
    const { adapter, model } = this.resolve(modelSelection);
    return adapter.stream({ ...request, model: model.id });
  }

  async complete(prompt: string, modelSelection: string): Promise<string> {
    let text = '';
    let reason: 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled' | undefined;

    for await (const event of this.stream(modelSelection, {
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === 'text_delta') {
        text += event.text;
      } else if (event.type === 'error') {
        throw Object.assign(new Error(event.error.message), { code: event.error.code });
      } else if (event.type === 'finish') {
        reason = event.reason;
      }
    }

    if (reason === 'error') {
      throw Object.assign(new Error('Model stream failed'), { code: 'stream_error' });
    }
    return text;
  }

  providerStatus(): { providerId: string; configured: boolean; enabled: boolean; keyless: boolean }[] {
    const ids = new Set<string>();
    for (const adapter of this.adapters) ids.add(adapter.id);
    for (const id of this.credentials.keys()) ids.add(id);
    for (const id of this.configs.keys()) ids.add(id);

    return [...ids]
      .sort((a, b) => this.rank(a) - this.rank(b))
      .map((providerId) => ({
        providerId,
        configured: this.isConfigured(providerId),
        enabled: this.isEnabled(providerId),
        keyless: KEYLESS_PROVIDER_IDS.has(providerId),
      }));
  }

  private usableAdapters(): ProviderAdapter[] {
    return this.sortedAdapters().filter(
      (adapter) => this.isConfigured(adapter.id) && this.isEnabled(adapter.id) && this.models.has(adapter.id),
    );
  }

  private sortedAdapters(): ProviderAdapter[] {
    return [...this.adapters].sort((a, b) => this.rank(a.id) - this.rank(b.id));
  }

  private rank(id: string): number {
    const slot = id.startsWith('custom:') ? 'custom' : id;
    const index = this.priority.indexOf(slot);
    return index === -1 ? this.priority.length : index;
  }

  /**
   * Providers that are usable without a stored credential: the DeepSeek web bridge
   * (`deepseek-chat`) authenticates with the browser session it manages itself, so an empty
   * key must not leave it perpetually "not configured" and permanently hidden from the picker.
   */
  private isConfigured(id: string): boolean {
    if (KEYLESS_PROVIDER_IDS.has(id)) return true;
    const key = this.credentials.get(id);
    return typeof key === 'string' && key.length > 0;
  }

  private isEnabled(id: string): boolean {
    return this.configs.get(id)?.enabled !== false;
  }
}
