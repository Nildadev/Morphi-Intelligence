import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from './gemini';
import type { LlmRequest, StreamEvent } from './types';

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(chunks: string[], status = 200, statusText = ''): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, statusText, headers: { 'content-type': 'text/event-stream' } });
}

function errorAfterFirstChunk(first: string, error: Error): Response {
  const encoder = new TextEncoder();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(first));
        return;
      }
      controller.error(error);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  return { url: String(url), init: (init ?? {}) as RequestInit };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    throw new Error('unexpected fetch call');
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GeminiAdapter.stream', () => {
  it('sends a thinking budget only when the caller chose an effort', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })]));

    await collect(adapter.stream(makeRequest({ effort: 'high' })));

    const body = JSON.parse(String(lastCall().init.body));
    // 24 576 is the `high` budget; includeThoughts is what makes the reasoning frames arrive at all.
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 24_576, includeThoughts: true } });
  });

  it('sends no thinkingConfig when no effort was chosen', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })]));

    await collect(adapter.stream(makeRequest()));

    expect(JSON.parse(String(lastCall().init.body)).generationConfig).toEqual({});
  });

  it('streams text, thought, function call, usage, and finish events', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sse({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
        sse({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] }),
        sse({ candidates: [{ content: { parts: [{ text: 'pondering', thought: true }] } }] }),
        sse({
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'locate', args: { location: 'Workspace' } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
        }),
      ]),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'reasoning_delta', text: 'pondering' },
      { type: 'tool_call_start', callId: expect.stringMatching(/^call_/), name: 'locate' },
      { type: 'tool_call_end', callId: expect.stringMatching(/^call_/), name: 'locate', args: { location: 'Workspace' } },
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    const start = events[3] as Extract<StreamEvent, { type: 'tool_call_start' }>;
    const end = events[4] as Extract<StreamEvent, { type: 'tool_call_end' }>;
    expect(start.callId).toMatch(/^call_/);
    expect(end.callId).toBe(start.callId);
  });

  it('reassembles a data line split across network chunks and flushes the final line', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"split"}]},"finishReason":"STOP"}]',
        '}\n\n',
      ]),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'text_delta', text: 'split' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('keeps only the latest usage metadata and emits it once before finish', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sse({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }),
        sse({
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      ]),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('finishes on finishReason without waiting for the stream to close and cancels the reader', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(sse({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] })),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'text_delta', text: 'done' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(cancelled).toBe(true);
  });

  it('finishes with stop at EOF when no finishReason or usage arrives', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [{ text: 'tail' }] } }] })]));

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'text_delta', text: 'tail' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it.each([
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'stop'],
  ] as const)('maps finishReason %s to %s', async (geminiReason, expected) => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      sseResponse([sse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: geminiReason }] })]),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events.at(-1)).toEqual({ type: 'finish', reason: expected });
  });

  it('emits a non-retryable stream error for malformed JSON payloads', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse(['data: {not json}\n\n']));

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'stream_error',
          message: expect.stringContaining('Malformed stream payload'),
          retryable: false,
        },
      },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('maps HTTP 429 to a retryable http error and finishes with error', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'error', error: { code: 'http_error', message: expect.any(String), retryable: true, status: 429 } },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('maps HTTP 400 to a non-retryable http error', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400, statusText: 'Bad Request' }));

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'error', error: { code: 'http_error', message: expect.any(String), retryable: false, status: 400 } },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('emits a retryable stream error when the transport fails', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'error', error: { code: 'stream_error', message: 'network down', retryable: true } },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('emits a non-retryable stream error when the response body is empty', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'error', error: { code: 'stream_error', message: expect.any(String), retryable: false } },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('finishes as cancelled without fetching when the signal is already aborted', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    const controller = new AbortController();
    controller.abort();

    const events = await collect(adapter.stream(makeRequest({ signal: controller.signal })));

    expect(events).toEqual([{ type: 'finish', reason: 'cancelled' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits a non-retryable error without fetching when the API key is missing', async () => {
    const adapter = new GeminiAdapter();

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      {
        type: 'error',
        error: { code: 'missing_api_key', message: 'Gemini API key is not set', retryable: false },
      },
      { type: 'finish', reason: 'error' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('finishes as cancelled when fetch rejects with an AbortError', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([{ type: 'finish', reason: 'cancelled' }]);
  });

  it('emits a retryable stream error when the body read fails mid-stream', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      errorAfterFirstChunk(sse({ candidates: [{ content: { parts: [{ text: 'one' }] } }] }), new Error('socket reset')),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([
      { type: 'text_delta', text: 'one' },
      { type: 'error', error: { code: 'stream_error', message: 'socket reset', retryable: true } },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('finishes as cancelled when the body read rejects with an AbortError', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      errorAfterFirstChunk(
        sse({ candidates: [{ content: { parts: [{ text: 'one' }] } }] }),
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ),
    );

    const events = await collect(adapter.stream(makeRequest()));

    expect(events).toEqual([{ type: 'text_delta', text: 'one' }, { type: 'finish', reason: 'cancelled' }]);
  });

  it('finishes as cancelled when the signal aborts during streaming', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sse({ candidates: [{ content: { parts: [{ text: 'one' }] } }] }),
        sse({ candidates: [{ content: { parts: [{ text: 'two' }] } }] }),
      ]),
    );

    const iterator = adapter.stream(makeRequest({ signal: controller.signal }))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: { type: 'text_delta', text: 'one' }, done: false });

    controller.abort();
    const remaining: StreamEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      remaining.push(next.value);
    }

    expect(remaining).toEqual([{ type: 'finish', reason: 'cancelled' }]);
  });

  it('sends the mapped Gemini request and resolves tool names from preceding calls', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [] } }] })]));

    await collect(
      adapter.stream(
        makeRequest({
          model: 'models/gemini-2.0-flash',
          messages: [
            { role: 'system', content: 'sys one' },
            { role: 'system', content: 'sys two' },
            { role: 'user', content: 'hi' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_abc', name: 'locate', args: { location: 'Workspace' } }],
            },
            { role: 'assistant', content: '' },
            { role: 'tool', content: '{"ok":true}', toolCallId: 'call_abc' },
            { role: 'tool', content: 'second', toolCallId: 'missing' },
            { role: 'assistant', content: 'after' },
          ],
          tools: [
            {
              name: 'locate',
              description: 'Locate a place',
              parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
            },
          ],
          signal: controller.signal,
        }),
      ),
    );

    const { url, init } = lastCall();
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=gm-key',
    );
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'sys one\n\nsys two' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'locate', args: { location: 'Workspace' } } }],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'locate', response: { result: '{"ok":true}' } } },
            { functionResponse: { name: 'missing', response: { result: 'second' } } },
          ],
        },
        { role: 'model', parts: [{ text: 'after' }] },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'locate',
              description: 'Locate a place',
              parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
            },
          ],
        },
      ],
      generationConfig: {},
    });
  });

  it('strips additionalProperties from tool schemas (Gemini 3 rejects the keyword)', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })]));

    const controller = new AbortController();
    await collect(
      adapter.stream(
        makeRequest({
          tools: [
            {
              name: 'locate',
              description: 'Locate a place',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  location: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' }, additionalProperties: false },
                },
                required: ['location'],
              },
            },
          ],
          signal: controller.signal,
        }),
      ),
    );

    const body = JSON.parse(String(lastCall().init.body));
    const declarations = body.tools[0].functionDeclarations;
    expect(JSON.stringify(declarations)).not.toContain('additionalProperties');
    // Everything else survives untouched.
    expect(declarations[0].parameters).toEqual({
      type: 'object',
      properties: {
        location: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['location'],
    });
  });

  it('starts a new user turn when an empty assistant separates tool responses', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [] } }] })]));

    await collect(
      adapter.stream(
        makeRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call_a', name: 'a', args: {} },
                { id: 'call_b', name: 'b', args: {} },
              ],
            },
            { role: 'tool', content: 'ra', toolCallId: 'call_a' },
            { role: 'assistant', content: '' },
            { role: 'tool', content: 'rb', toolCallId: 'call_b' },
          ],
        }),
      ),
    );

    const body = JSON.parse(String(lastCall().init.body));
    expect(body.contents).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'a', args: {} } },
          { functionCall: { name: 'b', args: {} } },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: { result: 'ra' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'b', response: { result: 'rb' } } }] },
    ]);
  });

  it('omits systemInstruction and tools when they are not provided', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [] } }] })]));

    await collect(adapter.stream(makeRequest()));

    const body = JSON.parse(String(lastCall().init.body));
    expect(body).not.toHaveProperty('systemInstruction');
    expect(body).not.toHaveProperty('tools');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('maps user image parts to inlineData beside the text', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [] } }] })]));

    await collect(
      adapter.stream(
        makeRequest({
          messages: [
            { role: 'user', content: 'ảnh này là gì?', imageParts: [{ mime: 'image/png', data: 'aGVsbG8=' }] },
          ],
        }),
      ),
    );

    const body = JSON.parse(String(lastCall().init.body));
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'ảnh này là gì?' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }],
      },
    ]);
  });

  it('sends an image-only user message without an empty text part', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ candidates: [{ content: { parts: [] } }] })]));

    await collect(
      adapter.stream(
        makeRequest({
          messages: [{ role: 'user', content: '', imageParts: [{ mime: 'image/png', data: 'aGVsbG8=' }] }],
        }),
      ),
    );

    const body = JSON.parse(String(lastCall().init.body));
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
    ]);
  });
});

describe('GeminiAdapter.listModels', () => {
  it('maps generateContent models and strips the models/ prefix', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      Response.json({
        models: [
          {
            name: 'models/gemini-2.0-flash',
            displayName: 'Gemini 2.0 Flash',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-1.5-pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-bison-001',
            displayName: 'Text Bison',
            inputTokenLimit: null,
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/embedding-001',
            displayName: 'Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    );

    const models = await adapter.listModels();

    expect(models).toEqual([
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        provider: 'google',
        providerLabel: 'Google AI Studio',
        context: 1048576,
        supportsTools: true,
      },
      {
        id: 'gemini-1.5-pro',
        name: 'gemini-1.5-pro',
        provider: 'google',
        providerLabel: 'Google AI Studio',
        supportsTools: true,
      },
      {
        id: 'text-bison-001',
        name: 'Text Bison',
        provider: 'google',
        providerLabel: 'Google AI Studio',
        supportsTools: false,
      },
    ]);

    expect(lastCall().url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=gm-key');
  });

  it('drops image/audio/video families even when they accept generateContent', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(
      Response.json({
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/lyria-3.0', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );

    const models = await adapter.listModels();
    expect(models.map((model) => model.id)).toEqual(['gemini-2.5-pro']);
  });

  it('throws without fetching when no API key is set', async () => {
    const adapter = new GeminiAdapter();

    await expect(adapter.listModels()).rejects.toThrow(/API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the models endpoint is not OK', async () => {
    const adapter = new GeminiAdapter();
    adapter.setApiKey('gm-key');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401, statusText: 'Unauthorized' }));

    await expect(adapter.listModels()).rejects.toThrow(/401/);
  });
});
