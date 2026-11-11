import { afterEach, describe, expect, it } from 'vitest';
import {
  DeepSeekAuthExpiredError,
  DeepSeekWebAdapter,
  buildDeepSeekPrompt,
  extractDelta,
  parseDeepSeekCredential,
  resetDeepSeekAppVersion,
  type DeepSeekAuth,
  type DeepSeekJson,
} from './deepseekWeb';
import type { LlmMessage, LlmRequest, StreamEvent } from './types';

/**
 * The web-chat wire, studied from github.com/AppsGanin/ai-free-vscode. The adapter is exercised
 * through an injected `fetch` and an injected PoW solver, so these tests never touch the network —
 * the shapes they assert are the ones the reference project measured live (patch stream, abbreviated
 * tails, THINK/RESPONSE fragments, PoW header, 40002 auth expiry, stop_stream on cancel).
 */

const AUTH: DeepSeekAuth = { token: 'bearer-token', cookieHeader: 'ds_session_id=abc; other=1' };

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(payload: DeepSeekJson, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake fetch wired the way chat.deepseek.com answers, recording every call. */
function fakeFetch(options: {
  session?: DeepSeekJson;
  challenge?: DeepSeekJson;
  stream?: unknown[];
  completionStatus?: number;
  completionBody?: string;
} = {}): typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('chat_session/create')) return jsonResponse(options.session ?? { data: { biz_data: { id: 'sess_1' } } });
    if (url.includes('create_pow_challenge')) {
      return jsonResponse(options.challenge ?? {
        data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c1', salt: 's1', difficulty: 1440, expire_at: 9999999999, signature: 'sig' } } },
      });
    }
    if (url.includes('chat/completion')) {
      if (options.completionStatus !== undefined && options.completionStatus !== 200) {
        return new Response(options.completionBody ?? 'nope', { status: options.completionStatus });
      }
      return sseResponse(options.stream ?? []);
    }
    return jsonResponse({});
  }) as typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> };
  return Object.assign(impl, { calls });
}

const SOLVED = { answer: 4242 };

function adapter(fetchImpl: typeof fetch): DeepSeekWebAdapter {
  const adapter = new DeepSeekWebAdapter({
    fetchImpl,
    solver: () => SOLVED.answer,
  });
  adapter.setApiKey(JSON.stringify(AUTH));
  return adapter;
}

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'deepseek-web',
  messages: [{ role: 'user', content: 'Xin chào' }],
  tools: [],
  signal: new AbortController().signal,
  ...overrides,
});

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => resetDeepSeekAppVersion());

describe('parseDeepSeekCredential', () => {
    it('parses the JSON credential and keeps the cookie jar', () => {
        expect(parseDeepSeekCredential(JSON.stringify(AUTH))).toEqual(AUTH);
    });

    it('accepts a bare JWT as the token but flags the missing cookies', () => {
        expect(parseDeepSeekCredential('a.b.c')).toEqual({ token: 'a.b.c', cookieHeader: '' });
    });

    it('refuses empty and garbage input', () => {
        expect(parseDeepSeekCredential('')).toBeNull();
        expect(parseDeepSeekCredential('not a credential')).toBeNull();
    });
});

describe('buildDeepSeekPrompt', () => {
    it('labels every role so the single prompt string keeps the transcript shape', () => {
        const messages: LlmMessage[] = [
            { role: 'system', content: 'Bạn là trợ lý.' },
            { role: 'user', content: 'Chào' },
            { role: 'assistant', content: 'Hi' },
            { role: 'tool', content: 'kết quả', toolCallId: 'call_1' },
            { role: 'user', content: 'Tiếp' },
        ];
        expect(buildDeepSeekPrompt(messages)).toBe(
            '[System]\nBạn là trợ lý.\n\n[User]\nChào\n\n[Assistant]\nHi\n\n[Tool result call_1]\nkết quả\n\n[User]\nTiếp',
        );
    });

    it('keeps the tail and the system line when the transcript exceeds the budget', () => {
        const big: LlmMessage[] = [
            { role: 'system', content: 'SYS' },
            ...Array.from({ length: 400 }, (_, index): LlmMessage => ({ role: 'user', content: `u${index} ${'x'.repeat(1000)}` })),
            { role: 'user', content: 'câu hỏi cuối' },
        ];
        const prompt = buildDeepSeekPrompt(big);
        expect(prompt.length).toBeLessThanOrEqual(300_000 + 2100);
        expect(prompt).toContain('[System]\nSYS');
        expect(prompt).toContain('câu hỏi cuối');
        expect(prompt).not.toContain('u0 ');
    });
});

describe('extractDelta — the patch stream', () => {
    it('follows APPEND patches and bare-tail continuations on the same channel', () => {
        const cache = new Map<string, string>();
        const state = { lastTarget: 'text' as const, fragmentTargets: [] };
        expect(extractDelta({ p: 'response/content', o: 'APPEND', v: 'Xin ' }, cache, state).text).toBe('Xin ');
        expect(extractDelta({ v: 'chào' }, cache, state).text).toBe('chào');
    });

    it('separates THINK fragments from RESPONSE fragments (reasoning must not leak into the answer)', () => {
        const cache = new Map<string, string>();
        const state = { lastTarget: 'text' as const, fragmentTargets: [] };
        // Opening snapshot registers the THINK fragment.
        extractDelta({ v: { response: { fragments: [{ type: 'THINK', content: 'suy' }] } } }, cache, state);
        expect(state.fragmentTargets).toEqual(['thinking']);
        // The follow-up patches address the last fragment by index.
        expect(extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: ' nghiệm' }, cache, state).thinking).toBe(' nghiệm');
        expect(extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: ' dần' }, cache, state).text).toBe('');
        // A RESPONSE fragment appended later flips the active channel back to the answer.
        extractDelta({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE' }] }, cache, state);
        expect(extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: 'Đáp' }, cache, state).text).toBe('Đáp');
        expect(extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: ' số' }, cache, state).thinking).toBe('');
    });

    it('diffs snapshot payloads so a full resend emits only the new tail', () => {
        const cache = new Map<string, string>();
        const state = { lastTarget: 'text' as const, fragmentTargets: [] };
        expect(extractDelta({ v: { content: 'Hel', type: 'response' } }, cache, state).text).toBe('Hel');
        expect(extractDelta({ v: { content: 'Hello', type: 'response' } }, cache, state).text).toBe('lo');
    });

    it('unwraps BATCH events and reads the message id for stop_stream', () => {
        const cache = new Map<string, string>();
        const state = { lastTarget: 'text' as const, fragmentTargets: [] };
        const delta = extractDelta({ o: 'BATCH', v: [{ response_message_id: 7 }, { p: 'response/content', o: 'APPEND', v: 'A' }] }, cache, state);
        expect(delta.text).toBe('A');
        expect(delta.messageId).toBe(7);
    });
});

describe('DeepSeekWebAdapter.stream', () => {
    it('creates a session, solves the PoW and streams text + thinking deltas', async () => {
        const fetchImpl = fakeFetch({
            stream: [
                { v: { response: { fragments: [{ type: 'THINK', content: 'đang' }] } } },
                { p: 'response/fragments/-1/content', o: 'APPEND', v: ' nghĩ' },
                { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE' }] },
                { p: 'response/content', o: 'APPEND', v: 'Chào ' },
                { v: 'bạn' },
            ],
        });
        const events = await collect(adapter(fetchImpl).stream(request()));

        const texts = events.filter((event) => event.type === 'text_delta').map((event) => (event as { text: string }).text);
        const thinkings = events.filter((event) => event.type === 'reasoning_delta').map((event) => (event as { text: string }).text);
        expect(texts.join('')).toBe('Chào bạn');
        expect(thinkings.join('')).toBe('đang nghĩ');
        expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });

        const completion = fetchImpl.calls.find((call) => call.url.includes('chat/completion'));
        expect(completion).toBeDefined();
        const headers = completion!.init?.headers as Record<string, string>;
        expect(headers.Cookie).toBe(AUTH.cookieHeader);
        expect(headers.Authorization).toBe(`Bearer ${AUTH.token}`);
        // The PoW answer travels base64-encoded with the challenge it solved.
        const pow = JSON.parse(Buffer.from(headers['X-DS-PoW-Response'], 'base64').toString('utf8')) as Record<string, unknown>;
        expect(pow).toMatchObject({ algorithm: 'DeepSeekHashV1', challenge: 'c1', salt: 's1', answer: SOLVED.answer, target_path: '/api/v0/chat/completion' });
        const body = JSON.parse(String(completion!.init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ chat_session_id: 'sess_1', model_type: 'default', thinking_enabled: false, parent_message_id: null });
        expect(String(body.prompt)).toContain('[User]\nXin chào');
    });

    it('maps the expert model to thinking_enabled', async () => {
        const fetchImpl = fakeFetch({ stream: [{ p: 'response/content', o: 'APPEND', v: 'ok' }] });
        await collect(adapter(fetchImpl).stream(request({ model: 'deepseek-web-expert' })));
        const body = JSON.parse(String(fetchImpl.calls.find((call) => call.url.includes('chat/completion'))!.init?.body)) as Record<string, unknown>;
        expect(body.model_type).toBe('expert');
        expect(body.thinking_enabled).toBe(true);
    });

    it('reports an in-stream biz error and stops the generation server-side', async () => {
        const fetchImpl = fakeFetch({
            stream: [{ type: 'error', content: 'too many generations', finish_reason: 'parallel_chat_limit' }],
        });
        const events = await collect(adapter(fetchImpl).stream(request()));
        expect(events).toContainEqual({ type: 'error', error: { code: 'stream_error', message: 'too many generations (parallel_chat_limit)', retryable: false } });
        expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'error' });
        expect(fetchImpl.calls.some((call) => call.url.includes('stop_stream'))).toBe(true);
    });

    it('maps 40002 to an auth-expired error the user can act on', async () => {
        const fetchImpl = fakeFetch({ session: { code: 40002 } });
        const events = await collect(adapter(fetchImpl).stream(request()));
        expect(events[0]).toMatchObject({ type: 'error', error: { code: 'AUTH_EXPIRED', retryable: false } });
        expect((events[0] as { error: { message: string } }).error.message).toContain('hết hạn');
    });

    it('calls stop_stream when the turn is cancelled mid-stream', async () => {
        // A stream that never ends on its own: the abort is what finishes the read.
        let sentResponse: Response | undefined;
        const fetchImpl = fakeFetch();
        const base = fetchImpl as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await base(input, init);
            if (String(input).includes('chat/completion')) {
                sentResponse = response;
                // Keep the body open: an endless SSE source.
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        const chunk = new TextEncoder().encode('data: {"p":"response/content","o":"APPEND","v":"x"}\n\n');
                        const timer = setInterval(() => controller.enqueue(chunk), 20);
                        (response as unknown as { _timer?: ReturnType<typeof setInterval> })._timer = timer;
                    },
                });
                return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
            }
            return response;
        }) as typeof fetch;
        const controller = new AbortController();
        const eventsPromise = collect(adapter(impl).stream(request({ signal: controller.signal })));
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.abort();
        const events = await eventsPromise;
        expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'cancelled' });
        expect(fetchImpl.calls.some((call) => call.url.includes('stop_stream'))).toBe(true);
        clearInterval((sentResponse as unknown as { _timer?: ReturnType<typeof setInterval> } | undefined)?._timer);
    });

    it('refuses to stream without a ds_session_id cookie', async () => {
        const adapter = new DeepSeekWebAdapter({ fetchImpl: fakeFetch(), solver: () => 1 });
        adapter.setApiKey(JSON.stringify({ token: 't', cookieHeader: 'other=1' }));
        const events = await collect(adapter.stream(request()));
        expect(events[0]).toMatchObject({ type: 'error', error: { code: 'NO_CREDENTIAL', retryable: false } });
    });

    it('lists no models until a real session credential is stored', async () => {
        const bare = new DeepSeekWebAdapter({ fetchImpl: fakeFetch(), solver: () => 1 });
        expect(await bare.listModels()).toEqual([]);
        bare.setApiKey(JSON.stringify(AUTH));
        const models = await bare.listModels();
        expect(models.map((model) => model.id)).toEqual(['deepseek-web', 'deepseek-web-expert']);
        expect(models.every((model) => model.supportsTools === false)).toBe(true);
    });
});
