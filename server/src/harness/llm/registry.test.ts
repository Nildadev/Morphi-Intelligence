import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmRegistry, NoProviderError } from './registry';
import type { LlmRequest, ModelInfo, ProviderAdapter, StreamEvent } from './types';

function model(id: string, provider: string, context?: number, supportsTools = true): ModelInfo {
  return {
    id,
    name: id,
    provider,
    providerLabel: provider,
    ...(context === undefined ? {} : { context }),
    supportsTools,
  };
}

const googleModels: ModelInfo[] = [
  model('gemini-2.0-flash', 'google', 1_000_000),
  model('gemini-2.0-pro', 'google', 2_000_000),
  model('gemma-large', 'google', 8_000_000, false),
  model('shared', 'google', 32_000),
];

const openaiModels: ModelInfo[] = [
  model('gpt-4o', 'openai', 4_000_000),
  model('gpt-4o-mini', 'openai', 64_000),
  model('shared', 'openai', 128_000),
];

function noopStream(): AsyncIterable<StreamEvent> {
  return (async function* () {
    yield { type: 'finish', reason: 'stop' } satisfies StreamEvent;
  })();
}

function streamOf(...events: StreamEvent[]): (request: LlmRequest) => AsyncIterable<StreamEvent> {
  return () =>
    (async function* () {
      for (const event of events) yield event;
    })();
}

class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  models: ModelInfo[];
  apiKey = '';
  baseUrls: string[] = [];
  listModels = vi.fn(async (): Promise<ModelInfo[]> => this.models);
  stream = vi.fn((_request: LlmRequest): AsyncIterable<StreamEvent> => noopStream());

  constructor(id: string, name: string, models: ModelInfo[] = []) {
    this.id = id;
    this.name = name;
    this.models = models;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrls.push(baseUrl);
  }
}

class KeyOnlyAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  models: ModelInfo[];
  apiKey = '';
  listModels = vi.fn(async (): Promise<ModelInfo[]> => this.models);
  stream = vi.fn((_request: LlmRequest): AsyncIterable<StreamEvent> => noopStream());

  constructor(id: string, name: string, models: ModelInfo[] = []) {
    this.id = id;
    this.name = name;
    this.models = models;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}

function setup(priority?: string[]) {
  const google = new FakeAdapter('google', 'Google AI Studio', googleModels);
  const openai = new FakeAdapter('openai', 'OpenAI', openaiModels);
  const registry = new LlmRegistry([google, openai], priority);
  return { google, openai, registry };
}

async function ready(priority?: string[]) {
  const context = setup(priority);
  context.registry.setCredentials({ google: 'g-key', openai: 'o-key' });
  await context.registry.refreshModels();
  return context;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LlmRegistry auto resolution', () => {
  it('prefers Google over OpenAI, then the largest-context tool-capable model', async () => {
    const { registry } = await ready();

    const selected = registry.resolveAuto();

    expect(selected?.provider).toBe('google');
    expect(selected?.id).toBe('gemini-2.0-pro');
  });

  it('honors a priority override', async () => {
    const { registry } = await ready(['openai', 'google']);

    expect(registry.resolveAuto()?.id).toBe('gpt-4o');
  });

  it('prefers the newest generation when context windows tie', async () => {
    // Google lists `gemini-2.5-flash` for keys that can no longer call it (404 "no longer available
    // to new users"), and it ties `gemini-3.8-flash` on the 1M context window. Auto must not pick
    // the retired generation just because it comes first in the API list.
    const adapter = new FakeAdapter('google', 'Google AI Studio', [
      model('gemini-2.5-flash', 'google', 1_048_576),
      model('gemini-2.5-pro', 'google', 1_048_576),
      model('gemini-3.8-flash', 'google', 1_048_576),
      model('gemini-flash-latest', 'google', 1_048_576),
    ]);
    const registry = new LlmRegistry([adapter]);
    registry.setCredentials({ google: 'g-key' });
    await registry.refreshModels();

    expect(registry.resolveAuto()?.id).toBe('gemini-3.8-flash');
  });

  it('returns the last selected model when it is still usable', async () => {
    const { registry } = await ready();

    expect(registry.resolveAuto('gpt-4o-mini')?.id).toBe('gpt-4o-mini');
  });

  it('falls back to priority order when the last selected model is not usable', async () => {
    const { registry } = await ready();
    registry.setCredentials({ google: 'g-key' });
    await registry.refreshModels();

    expect(registry.resolveAuto('gpt-4o')?.id).toBe('gemini-2.0-pro');
  });

  it('returns undefined and resolve throws NoProviderError when nothing is usable', () => {
    const { registry } = setup();

    expect(registry.resolveAuto()).toBeUndefined();
    expect(() => registry.resolve('auto')).toThrow(NoProviderError);
    try {
      registry.resolve('gpt-4o');
      throw new Error('expected resolve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(NoProviderError);
      expect((error as NoProviderError).code).toBe('NO_PROVIDER');
    }
  });

  it('ignores providers without a tool-capable model', async () => {
    const adapter = new FakeAdapter('google', 'Google AI Studio', [model('gemma-large', 'google', 8_000_000, false)]);
    const registry = new LlmRegistry([adapter]);
    registry.setCredentials({ google: 'g-key' });
    await registry.refreshModels();

    expect(registry.resolveAuto()).toBeUndefined();
    expect(() => registry.resolve('auto')).toThrow(NoProviderError);
  });
});

describe('LlmRegistry model selection', () => {
  it('resolves an explicit model id to its adapter', async () => {
    const { registry, openai } = await ready();

    const resolved = registry.resolve('gpt-4o-mini');

    expect(resolved.adapter).toBe(openai);
    expect(resolved.model.id).toBe('gpt-4o-mini');
  });

  it('treats auto, empty, and undefined selections as auto', async () => {
    const { registry } = await ready();

    expect(registry.resolve('auto').model.id).toBe('gemini-2.0-pro');
    expect(registry.resolve('').model.id).toBe('gemini-2.0-pro');
    expect(registry.resolve(undefined as unknown as string).model.id).toBe('gemini-2.0-pro');
  });

  it('falls back to auto when the selected model is not usable', async () => {
    const { registry, google } = await ready();
    registry.setCredentials({ google: 'g-key' });
    await registry.refreshModels();

    const resolved = registry.resolve('gpt-4o');

    expect(resolved.adapter).toBe(google);
    expect(resolved.model.id).toBe('gemini-2.0-pro');
  });

  it('resolves duplicate ids to the first model in provider-priority order', async () => {
    const { registry, google } = await ready();

    expect(registry.resolve('shared').adapter).toBe(google);
  });
});

describe('LlmRegistry refresh and credentials', () => {
  it('refreshes only configured and enabled providers', async () => {
    const { registry, google, openai } = setup();
    registry.setCredentials({ google: 'g-key' });

    await registry.refreshModels();

    expect(google.listModels).toHaveBeenCalledTimes(1);
    expect(openai.listModels).not.toHaveBeenCalled();
    expect(registry.getModels()).toEqual(googleModels);

    registry.setProviderConfig('google', { enabled: false });
    await registry.refreshModels();

    expect(google.listModels).toHaveBeenCalledTimes(1);
    expect(registry.getModels()).toEqual([]);
  });

  it('logs failures and keeps the previous model cache', async () => {
    const { registry, google } = await ready();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    google.listModels.mockRejectedValueOnce(new Error('boom'));

    await registry.refreshModels();

    expect(registry.getModels()).toEqual([...googleModels, ...openaiModels]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('google');
  });

  it('clears a provider cache when its credential changes or disappears', async () => {
    const { registry } = await ready();
    expect(registry.getModels()).toHaveLength(googleModels.length + openaiModels.length);

    registry.setCredentials({ google: 'g-key' });
    expect(registry.getModels()).toEqual(googleModels);

    registry.setCredentials({ google: 'g-key-rotated' });
    expect(registry.getModels()).toEqual([]);

    registry.setCredentials({});
    expect(registry.getModels()).toEqual([]);
  });

  it('applies an empty key to adapters missing from the map', async () => {
    const { registry, openai } = setup();
    registry.setCredentials({ openai: 'o-key' });
    expect(openai.apiKey).toBe('o-key');

    registry.setCredentials({});
    expect(openai.apiKey).toBe('');
  });
});

describe('LlmRegistry provider configuration', () => {
  it('applies base URLs and records enabled without touching keys', async () => {
    const { registry, openai } = await ready();

    registry.setProviderConfig('openai', { baseUrl: 'https://proxy.test/v1' });

    expect(openai.baseUrls).toEqual(['https://proxy.test/v1']);
    expect(openai.apiKey).toBe('o-key');
    expect(registry.providerStatus()).toContainEqual({ providerId: 'openai', configured: true, enabled: true, keyless: false });

    registry.setProviderConfig('openai', { enabled: false });
    expect(registry.providerStatus()).toContainEqual({ providerId: 'openai', configured: true, enabled: false, keyless: false });
    expect(registry.getModels().some((entry) => entry.provider === 'openai')).toBe(false);
  });

  it('records configuration for adapters that do not implement setBaseUrl', () => {
    const geminiLike = new KeyOnlyAdapter('google', 'Google AI Studio', googleModels);
    const registry = new LlmRegistry([geminiLike]);

    expect(() => registry.setProviderConfig('google', { baseUrl: 'https://ignored.test', enabled: false })).not.toThrow();
    expect(registry.providerStatus()).toEqual([{ providerId: 'google', configured: false, enabled: false, keyless: false }]);
  });

  it('invalidates the provider model cache when the base URL changes', async () => {
    const { registry } = await ready();
    expect(registry.getModels().some((entry) => entry.provider === 'openai')).toBe(true);

    registry.setProviderConfig('openai', { baseUrl: 'https://proxy.test/v1' });

    expect(registry.getModels().some((entry) => entry.provider === 'openai')).toBe(false);
    expect(registry.getModels().some((entry) => entry.provider === 'google')).toBe(true);
  });
});

describe('LlmRegistry custom providers', () => {
  it('rejects invalid custom provider ids', () => {
    const { registry } = setup();

    for (const invalid of ['foo', 'custom:', 'custom:Foo', 'custom:foo_bar', 'custom:foo bar']) {
      expect(() => registry.addCustomProvider(invalid, 'http://localhost:9000/v1')).toThrow(
        /Invalid custom provider id/,
      );
    }
  });

  it('creates a custom provider that becomes usable after a key and refresh', async () => {
    const { registry } = setup();
    registry.addCustomProvider('custom:local', 'http://localhost:9000/v1');
    registry.setCredentials({ 'custom:local': 'local-key' });

    const fetchMock = vi.fn(async (_url: string | URL | Request): Promise<Response> =>
      Response.json({ data: [{ id: 'local-chat', context_length: 2000 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await registry.refreshModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:9000/v1/models');
    expect(registry.getModels()).toEqual([
      {
        id: 'local-chat',
        name: 'local-chat',
        provider: 'custom:local',
        providerLabel: 'custom:local',
        context: 2000,
        supportsTools: true,
      },
    ]);
    expect(registry.resolve('local-chat').adapter.id).toBe('custom:local');
  });

  it('is idempotent and updates the base URL of an existing custom provider', async () => {
    const { registry } = setup();
    registry.addCustomProvider('custom:local', 'http://localhost:9000/v1');
    registry.setCredentials({ 'custom:local': 'local-key' });
    const fetchMock = vi.fn(async (_url: string | URL | Request): Promise<Response> =>
      Response.json({ data: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    registry.addCustomProvider('custom:local', 'http://localhost:9001/v1/');
    await registry.refreshModels();

    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('http://localhost:9001/v1/models');
    expect(registry.providerStatus().filter((entry) => entry.providerId === 'custom:local')).toHaveLength(1);
  });

  it('applies a credential that arrived before the custom adapter was created', async () => {
    const { registry } = setup();
    registry.setCredentials({ 'custom:local': 'local-key' });
    registry.addCustomProvider('custom:local', 'http://localhost:9000/v1');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer local-key');
        return Response.json({ data: [{ id: 'local-chat' }] });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    await registry.refreshModels();

    expect(registry.getModels()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ranks custom providers at the custom priority slot', async () => {
    const { registry } = setup();
    registry.addCustomProvider('custom:local', 'http://localhost:9000/v1');
    registry.setCredentials({ google: 'g-key', 'custom:local': 'local-key' });
    const fetchMock = vi.fn(async (_url: string | URL | Request): Promise<Response> =>
      Response.json({ data: [{ id: 'local-chat', context_length: 99_000_000 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await registry.refreshModels();

    expect(registry.getModels().map((entry) => entry.provider)).toEqual([
      'google',
      'google',
      'google',
      'google',
      'custom:local',
    ]);
    expect(registry.resolveAuto()?.provider).toBe('google');
  });
});

describe('LlmRegistry.providerStatus', () => {
  it('returns the union of adapters, credentials, and configs in priority order', () => {
    const { registry } = setup();
    registry.addCustomProvider('custom:x', 'http://localhost:9000/v1');
    registry.setCredentials({ openai: 'o-key', 'custom:x': 'c-key', extra: 'e-key' });
    registry.setProviderConfig('openrouter', { enabled: false });
    registry.setProviderConfig('custom:x', { enabled: false });

    expect(registry.providerStatus()).toEqual([
      { providerId: 'google', configured: false, enabled: true, keyless: false },
      { providerId: 'openai', configured: true, enabled: true, keyless: false },
      { providerId: 'openrouter', configured: false, enabled: false, keyless: false },
      { providerId: 'custom:x', configured: true, enabled: false, keyless: false },
      { providerId: 'extra', configured: true, enabled: true, keyless: false },
    ]);
  });

  it('treats a keyless provider as configured with no credential stored', () => {
    // The local DeepSeek bridge authenticates with the browser session it manages itself, so
    // `isConfigured` must not depend on a key the user cannot supply.
    const bridge = new FakeAdapter('deepseek-chat', 'DeepSeek Chat', []);
    const registry = new LlmRegistry([bridge]);
    const bridgeSpy = vi.spyOn(bridge, 'listModels').mockResolvedValue([]);
    void bridgeSpy;

    expect(registry.providerStatus()).toEqual([
      { providerId: 'deepseek-chat', configured: true, enabled: true, keyless: true },
    ]);
  });

  it('refreshes a keyless provider even with no credential at all', async () => {
    const bridge = new FakeAdapter('deepseek-chat', 'DeepSeek Chat', []);
    const registry = new LlmRegistry([bridge]);

    await registry.refreshModels();

    expect(bridge.listModels).toHaveBeenCalledTimes(1);
    expect(registry.getModels().map((entry) => entry.provider)).toEqual([]);
  });

  it('drops a retired provider credential instead of resurrecting its card', () => {
    const { registry } = setup();
    registry.setCredentials({ google: 'g-key', proxypal: 'old-key' });
    registry.setProviderConfig('proxypal', { enabled: false });

    expect(registry.providerStatus().map((entry) => entry.providerId)).not.toContain('proxypal');
  });
});

describe('LlmRegistry stream and complete', () => {
  it('delegates streaming to the resolved adapter with the resolved model id', async () => {
    const { registry, openai } = await ready();
    const controller = new AbortController();
    const messages = [{ role: 'user' as const, content: 'hi' }];

    const events = await collect(
      registry.stream('gpt-4o', { messages, tools: [], signal: controller.signal }),
    );

    expect(events).toEqual([{ type: 'finish', reason: 'stop' }]);
    const request = openai.stream.mock.calls[0][0];
    expect(request.model).toBe('gpt-4o');
    expect(request.messages).toBe(messages);
    expect(request.signal).toBe(controller.signal);
  });

  it('throws NoProviderError synchronously when no provider is usable', () => {
    const { registry } = setup();

    expect(() =>
      registry.stream('auto', { messages: [], tools: [], signal: new AbortController().signal }),
    ).toThrow(NoProviderError);
  });

  it('concatenates text deltas without tools', async () => {
    const { registry, openai } = await ready();
    openai.stream.mockImplementation(
      streamOf(
        { type: 'reasoning_delta', text: 'hmm' },
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'finish', reason: 'stop' },
      ),
    );

    await expect(registry.complete('Write a title', 'gpt-4o')).resolves.toBe('Hello world');

    const request = openai.stream.mock.calls[0][0];
    expect(request.messages).toEqual([{ role: 'user', content: 'Write a title' }]);
    expect(request.tools).toEqual([]);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws with the error event code when the stream errors', async () => {
    const { registry, openai } = await ready();
    openai.stream.mockImplementation(
      streamOf(
        { type: 'error', error: { code: 'http_error', message: 'boom', retryable: false, status: 400 } },
        { type: 'finish', reason: 'error' },
      ),
    );

    await expect(registry.complete('prompt', 'gpt-4o')).rejects.toMatchObject({
      message: 'boom',
      code: 'http_error',
    });
  });

  it('throws when the stream finishes with error and no error event', async () => {
    const { registry, openai } = await ready();
    openai.stream.mockImplementation(streamOf({ type: 'finish', reason: 'error' }));

    await expect(registry.complete('prompt', 'gpt-4o')).rejects.toMatchObject({ code: 'stream_error' });
  });
});
