import { describe, expect, it } from 'vitest';
import { createFakeAdapter, FAKE_TOOL_NAME, scriptFromMessage } from './fake';
import type { LlmRequest, StreamEvent } from './types';

/**
 * Task 25 — fake LLM seam. These tests are the RED half of the E2E harness: they pin the exact
 * event vocabulary the AgentLoop consumes (loop.ts:380-415), so an E2E failure can be attributed to
 * the browser or the product, never to a guessed stream shape.
 *
 * No network, no database, no timers beyond the scripted ones. `signal` is always honoured.
 */
const makeRequest = (message: string, overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'fake-tools',
  messages: [{ role: 'user', content: message }],
  tools: [],
  signal: new AbortController().signal,
  ...overrides,
});

const collect = async (events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

describe('scriptFromMessage', () => {
  it('reads a leading /script marker and ignores a marker in the middle of a sentence', () => {
    expect(scriptFromMessage('/script slow xin chào', 'text')).toBe('slow');
    expect(scriptFromMessage('xin chào /script slow', 'text')).toBe('text');
    expect(scriptFromMessage('/script does-not-exist', 'cancel')).toBe('cancel');
    expect(scriptFromMessage('không có marker', 'tool-then-text')).toBe('tool-then-text');
  });
});

describe('createFakeAdapter', () => {
  it('publishes exactly the two deterministic models on the fake provider', async () => {
    const models = await createFakeAdapter().listModels();
    expect(models.map((model) => model.id)).toEqual(['fake-tools', 'fake-text']);
    expect(models.every((model) => model.provider === 'fake')).toBe(true);
    expect(models.find((model) => model.id === 'fake-tools')?.supportsTools).toBe(true);
    expect(models.find((model) => model.id === 'fake-text')?.supportsTools).toBe(false);
  });

  it('text script emits real deltas and a stop finish', async () => {
    const events = await collect(createFakeAdapter().stream(makeRequest('/script text')));
    const text = events.filter((event) => event.type === 'text_delta').map((event) => (event as { text: string }).text).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('tool-then-text emits one complete call on the first pass', async () => {
    const events = await collect(createFakeAdapter().stream(makeRequest('/script tool-then-text')));
    const end = events.find((event) => event.type === 'tool_call_end');
    expect(end).toMatchObject({ type: 'tool_call_end', name: FAKE_TOOL_NAME });
    expect((end as { args: unknown }).args).toEqual({ text: 'probe-from-fake' });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('streams reasoning frames when an effort is chosen, and none when it is not', async () => {
    const withEffort = await collect(createFakeAdapter().stream(makeRequest('/script text', { effort: 'medium' })));
    const reasoning = withEffort
      .filter((event) => event.type === 'reasoning_delta')
      .map((event) => (event as { text: string }).text)
      .join('');
    expect(reasoning).toContain('Mức medium');
    // The frames must arrive before the answer, exactly like a real thinking model.
    expect(withEffort.findIndex((event) => event.type === 'reasoning_delta'))
      .toBeLessThan(withEffort.findIndex((event) => event.type === 'text_delta'));

    const without = await collect(createFakeAdapter().stream(makeRequest('/script text')));
    expect(without.some((event) => event.type === 'reasoning_delta')).toBe(false);
  });

  it('studio-state calls the real Studio tool and then quotes what it returned', async () => {
    const first = await collect(createFakeAdapter().stream(makeRequest('/script studio-state')));
    const end = first.find((event) => event.type === 'tool_call_end');
    expect(end).toMatchObject({ type: 'tool_call_end', name: 'studio.get_studio_state' });
    // No arguments: the gateway injects studio_id, so a model must never be asked for it.
    expect((end as { args: unknown }).args).toEqual({});

    const second = await collect(createFakeAdapter().stream(makeRequest('/script studio-state', {
      messages: [
        { role: 'user', content: '/script studio-state' },
        { role: 'tool', content: '- Current Studio Mode: Edit', toolCallId: 'fake_studio_1' },
      ],
    })));
    const text = second.filter((event) => event.type === 'text_delta').map((event) => (event as { text: string }).text).join('');
    expect(text).toContain('Current Studio Mode: Edit');
  });

  it('studio-insert asks for a mutating Studio tool, so the approval gate is exercised', async () => {
    const events = await collect(createFakeAdapter().stream(makeRequest('/script studio-insert')));
    const end = events.find((event) => event.type === 'tool_call_end');
    expect(end).toMatchObject({ type: 'tool_call_end', name: 'studio.insert_asset' });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('a different studio script still runs after another one already answered', async () => {
    // Two scripts in one session: the read-only call's result must not silence the mutating call.
    const events = await collect(createFakeAdapter().stream(makeRequest('/script studio-insert', {
      messages: [
        { role: 'user', content: '/script studio-state' },
        { role: 'tool', content: '- Current Studio Mode: Edit', toolCallId: 'fake_studio_1' },
        { role: 'user', content: '/script studio-insert' },
      ],
    })));
    expect(events.find((event) => event.type === 'tool_call_end')).toMatchObject({ name: 'studio.insert_asset' });
  });

  it('tool-then-text answers with text once a tool result is in the transcript', async () => {
    const events = await collect(createFakeAdapter().stream(makeRequest('/script tool-then-text', {
      messages: [
        { role: 'user', content: '/script tool-then-text' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: FAKE_TOOL_NAME, args: { text: 'probe-from-fake' } }] },
        { role: 'tool', content: '{"echo":"probe-from-fake"}', toolCallId: 'call_1' },
      ],
    })));
    expect(events.some((event) => event.type === 'tool_call_end')).toBe(false);
    expect(events.some((event) => event.type === 'text_delta')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('missing-key emits a live NO_PROVIDER error through the stream, not a made-up code', async () => {
    const events = await collect(createFakeAdapter().stream(makeRequest('/script missing-key')));
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error', error: { code: 'NO_PROVIDER', retryable: false } });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'error' });
  });

  it('honours the abort signal: a cancelled slow turn stops emitting and never claims completion', async () => {
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    const stream = createFakeAdapter({ chunkDelayMs: 25 }).stream(makeRequest('/script slow', { signal: controller.signal }));
    for await (const event of stream) {
      seen.push(event);
      if (event.type === 'text_delta') controller.abort();
    }
    expect(seen.length).toBeLessThan(10);
    expect(seen.some((event) => event.type === 'finish' && event.reason === 'stop')).toBe(false);
  });

  it('never needs a credential: setApiKey/setBaseUrl are inert and the adapter stays local', async () => {
    const adapter = createFakeAdapter();
    adapter.setApiKey?.('');
    adapter.setBaseUrl?.('https://example.invalid');
    expect(await adapter.listModels()).toHaveLength(2);
  });
});
