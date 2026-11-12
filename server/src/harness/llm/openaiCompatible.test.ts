import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from './openaiCompatible';
import type { ToolSchema } from './types';

/**
 * Replace `fetch` with a stub. A stub implements only the fields the adapter reads (`ok`, `status`,
 * `json`, `text`, `body`), which is not the whole `Response` contract, so it is cast here ONCE. The
 * sixteen `@ts-expect-error stub` directives this replaces had gone stale: most of them no longer
 * suppressed anything, and an unused directive hides the next real error on the same line.
 */
function stubFetch(stub: unknown): typeof fetch {
  return stub as unknown as typeof fetch;
}
import type { LlmRequest } from './types';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  } as LlmRequest;
}

// Access the private requestBody through the public stream surface is awkward;
// the wire is the contract, so assert on the fetch body by stubbing fetch.
describe('OpenAICompatibleAdapter output cap', () => {
  it('sends an explicit max_tokens so OpenRouter never charges for 65536', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://example.test' });
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async (_url: string, init: { body?: string }) => {
      body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });
    try {
      for await (const event of adapter.stream(request())) {
        void event;
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(body.max_tokens).toBe(8192);
  });

  it('honours an explicit smaller cap from the subagent runner', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://example.test' });
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async (_url: string, init: { body?: string }) => {
      body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });
    try {
      for await (const event of adapter.stream(request({ maxTokens: 4096 }))) {
        void event;
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(body.max_tokens).toBe(4096);
  });
});

describe('OpenAICompatibleAdapter listModels', () => {
  it('reads reasoning efforts from the declared supported_efforts and never guesses by name', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'some/reasoner', context_length: 200_000,
            architecture: { output_modalities: ['text'], input_modalities: ['text'] },
            supported_parameters: ['tools', 'reasoning'],
            reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] },
          },
          {
            id: 'some/top-level', context_length: 100_000,
            architecture: { output_modalities: ['text'] },
            supported_parameters: ['tools'],
            supported_efforts: ['high', 'low'],
          },
          {
            id: 'some/embedder', context_length: 8000,
            architecture: { output_modalities: ['embedding'] },
          },
          {
            // Text + image output (painters): text-capable but not text-ONLY — the picker is
            // text-output only, so this never lists.
            id: 'some/painter', context_length: 100_000,
            architecture: { output_modalities: ['text', 'image'] },
          },
          {
            // Declares no efforts: a classic family name is not enough — no selector, no guess.
            id: 'gpt-5-legacy', context_length: 400_000,
            architecture: { output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
        ],
      }),
    }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toEqual(['some/reasoner', 'some/top-level', 'gpt-5-legacy']);
      // Only what the catalogue declared, verbatim, ordered least-to-most for the slider.
      expect(models[0]?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(models[1]?.efforts).toEqual(['low', 'high']);
      expect(models[2]?.efforts).toBeUndefined();
      expect(models[0]?.supportsImages).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps only text-output models when the catalogue stays silent on modalities', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'some/chat' },
          { id: 'black-forest-labs/flux-schnell' },
          { id: 'google/veo-3' },
          { id: 'openai/tts-1' },
          { id: 'elevenlabs/multilingual-v2-tts' },
          { id: 'cohere/rerank-v3' },
        ],
      }),
    }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toEqual(['some/chat']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * NVIDIA NIM / Kilo Gateway: the wire listing carries no metadata (ids and `owned_by` only), so
 * the bundled cards are the lineup and the wire is only the availability check.
 */
describe('OpenAICompatibleAdapter catalog-backed providers', () => {
  /** NIM's real listing shape: every id, including embedders and safety guards, with no fields. */
  function nimStub(ids: string[]) {
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id, object: 'model', owned_by: id.split('/')[0] })) }) };
  }

  it('offers the live cards with the metadata the wire never sends', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => nimStub([
      'deepseek-ai/deepseek-v4.1-flash',
      'google/gemma-3-12b-it',
      'nvidia/embed-qa-4',       // embedder: no card, never a chat model
      'nvidia/llama-3.1-nemoguard-8b-topic-control',
    ]) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toEqual(['deepseek-ai/deepseek-v4.1-flash', 'google/gemma-3-12b-it']);
      // The card supplies what NIM's list cannot: a real display name, the context window and the
      // effort ladder (the composer offers a level only where the endpoint accepts one).
      expect(models[0]).toMatchObject({
        name: 'DeepSeek V4.1 Flash',
        context: 1_000_000,
        supportsTools: true,
        supportsImages: true,
        efforts: ['low', 'high', 'max'],
        providerLabel: 'NVIDIA NIM',
      });
      expect(models[1]?.efforts).toBeUndefined();
      expect(models[1]?.context).toBe(131072);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('stands on the whole catalogue when the gateway renames its models', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({ ok: true, json: async () => ({ data: [{ id: 'kilo/x-ai/grok-4.3' }] }) }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      // A shared id does not exist, so an intersection would empty the picker for a key that just
      // listed models fine; the catalogue is the lineup instead.
      expect(models.length).toBeGreaterThan(300);
      expect(models.every((model) => model.id !== 'kilo/x-ai/grok-4.3')).toBe(true);
      expect(models[0]?.providerLabel).toBe('Kilo Gateway');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps a catalogue-free provider on the wire-declared path', async () => {
    // OpenRouter is the one provider we deliberately keep out of the snapshot: its own listing
    // is the richest of them all, so the wire path must survive a provider with no cards.
    const adapter = new OpenAICompatibleAdapter({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o-mini', context_length: 128_000 }] }),
    }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({ id: 'gpt-4o-mini', name: 'gpt-4o-mini', supportsTools: true });
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * Enrichment: providers (OpenAI, DeepSeek, Groq, ...) list ids with no context or effort facts,
 * so the wire row stands and the bundled card fills only what it omitted. A wire-declared fact
 * always wins — the card never overrides what the endpoint itself said.
 */
describe('OpenAICompatibleAdapter catalog-enriched providers', () => {
  it('fills context, efforts and the display name from the card', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'openai', name: 'OpenAI', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-5.1' }, { id: 'gpt-4o-mini' }] }),
    }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toEqual(['gpt-5.1', 'gpt-4o-mini']);
      expect(models[0]).toMatchObject({
        name: 'GPT-5.1',
        context: 400_000,
        supportsTools: true,
        efforts: ['low', 'medium', 'high'],
      });
      // A card with no reasoning knob stays silent: no fake selector appears.
      expect(models[1]).toMatchObject({ name: 'GPT-4o mini', context: 128_000 });
      expect(models[1]?.efforts).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps a wire-declared fact over the card', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'deepseek-chat',
          context_length: 65_536,
          reasoning: { supported_efforts: ['medium', 'max'] },
        }],
      }),
    }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      // The card would say 128_000 and low/medium/high; the wire says otherwise, so the wire wins.
      expect(models[0]).toMatchObject({
        context: 65_536,
        efforts: ['medium', 'max'],
        supportsTools: true,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('offers a tool-less card as tool-less', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'groq', name: 'Groq', baseUrl: 'https://example.test' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'brand-new-model-the-snapshot-has-never-heard-of' }] }),
    }) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toHaveLength(2);
      expect(models[0]).toMatchObject({ name: 'Llama 3.1 8B', context: 131_072, supportsTools: true });
      // An id the snapshot does not know keeps its wire-only row (raw id, name heuristic).
      expect(models[1]).toMatchObject({ id: 'brand-new-model-the-snapshot-has-never-heard-of', name: 'brand-new-model-the-snapshot-has-never-heard-of' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * The local DeepSeek bridge (sums001/Deepseek-API): its /v1/models lists two ids and no
 * metadata, so the hand-written cards are the lineup. The wire never emits tool calls.
 */
describe('OpenAICompatibleAdapter deepseek-chat bridge', () => {
  /** The bridge's real /v1/models shape (server/api.py): ids plus owned_by, nothing else. */
  function bridgeStub(ids: string[]) {
    return { ok: true, json: async () => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 735790403, owned_by: 'deepseek' })) }) };
  }

  it('offers both models as tool-free chat', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'deepseek-chat', name: 'DeepSeek Chat', baseUrl: 'http://127.0.0.1:8000/v1' });
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async () => bridgeStub(['deepseek-chat', 'deepseek-expert']) as unknown as Response);
    try {
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-expert']);
      for (const model of models) {
        // The bridge ignores tool definitions, so the loop sends none and Studio tools are
        // unreachable through it (honest, not a silent no-op on the wire).
        expect(model.supportsTools).toBe(false);
        expect(model.efforts).toBeUndefined();
      }
      expect(models[0]?.name).toBe('DeepSeek Chat (Instant)');
      expect(models[1]?.name).toBe('DeepSeek Chat (Expert)');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('translates a picked reasoning level into the thinking toggle', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'deepseek-chat', name: 'DeepSeek Chat', baseUrl: 'http://127.0.0.1:8000/v1' });
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async (_url: string, init: { body?: string }) => {
      body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });
    try {
      for await (const _event of adapter.stream(request({ model: 'deepseek-expert', effort: 'high' }))) {
        // drain: the stream generator only fires the request once iterated.
      }
      // The bridge has no effort ladder: `reasoning_effort` does nothing, DeepThink is `thinking`.
      expect(body.thinking).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('leaves thinking off for the low level', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'deepseek-chat', name: 'DeepSeek Chat', baseUrl: 'http://127.0.0.1:8000/v1' });
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(async (_url: string, init: { body?: string }) => {
      body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });
    try {
      for await (const _event of adapter.stream(request({ model: 'deepseek-chat', effort: 'low' }))) {
        // drain
      }
      expect(body.thinking).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * Studio tools are published as `studio.<name>`, and OpenAI-compatible function names only allow
 * `[a-zA-Z0-9_-]` — Anthropic answers a dotted name with a 400 that kills the whole turn. The wire
 * therefore gets a safe alias, and everything the provider says about tools comes back translated.
 */
describe('OpenAICompatibleAdapter tool names on the wire', () => {
  /** The tool list Studio actually publishes: dotted MCP-prefixed names. */
  // Typed as the adapter's own `ToolSchema[]`: `as const` made it a readonly tuple, which the
  // parameter rejects — the fixture must be exactly what the adapter accepts.
  const studioTools: ToolSchema[] = [
    { name: 'studio.upload_image', description: 'upload', parameters: { type: 'object' } },
    { name: 'studio.script_read', description: 'read', parameters: { type: 'object' } },
    { name: 'get_studio_state', description: 'state', parameters: { type: 'object' } },
  ];

  function streamStub(record: { body?: Record<string, unknown>; events: Array<Record<string, unknown>> }) {
    return async (_url: string, init: { body?: string }) => {
      record.body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      const lines = record.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${lines}data: [DONE]\n\n`));
            controller.close();
          },
        }),
      } as unknown as Response;
    };
  }

  it('sends studio names as safe aliases and translates a call back to the real name', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://example.test' });
    const record: { body?: Record<string, unknown>; events: Array<Record<string, unknown>> } = { events: [
      // The provider echoes the alias it was given.
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'studio_upload_image', arguments: '{"id":7}' } }] }, finish_reason: 'tool_calls' }] },
    ] };
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(streamStub(record));
    try {
      const events = [];
      for await (const event of adapter.stream(request({ tools: studioTools }))) {
        events.push(event);
      }
      const sent = (record.body?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
      // No dot reaches the wire — this is the request Anthropic no longer answers with a 400.
      expect(sent).toEqual(['studio_upload_image', 'studio_script_read', 'get_studio_state']);
      // …and the call comes back as the name the pipeline and the UI know.
      expect(events).toContainEqual({ type: 'tool_call_start', callId: 'call_1', name: 'studio.upload_image' });
      expect(events).toContainEqual({ type: 'tool_call_end', callId: 'call_1', name: 'studio.upload_image', args: { id: 7 } });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('aliases an echoed assistant tool_call the same way', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://example.test' });
    const record: { body?: Record<string, unknown>; events: Array<Record<string, unknown>> } = { events: [
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ] };
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(streamStub(record));
    try {
      for await (const _event of adapter.stream(request({
        tools: studioTools,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'studio.upload_image', args: { id: 7 } }],
          },
        ],
      }))) {
        // drain
      }
      const echo = (record.body?.messages as Array<Record<string, unknown>>)[1];
      const call = (echo.tool_calls as Array<{ function: { name: string } }>)[0];
      expect(call.function.name).toBe('studio_upload_image');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps two Studio names apart when their aliases would collide', async () => {
    const adapter = new OpenAICompatibleAdapter({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://example.test' });
    const record: { body?: Record<string, unknown>; events: Array<Record<string, unknown>> } = { events: [
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ] };
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(streamStub(record));
    try {
      for await (const _event of adapter.stream(request({
        tools: [
          { name: 'a.b', description: 'first', parameters: { type: 'object' } },
          { name: 'a_b', description: 'second', parameters: { type: 'object' } },
        ],
      }))) {
        // drain
      }
      expect((record.body?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
        .toEqual(['a_b', 'a_b_2']);
    } finally {
      globalThis.fetch = original;
    }
  });
});
