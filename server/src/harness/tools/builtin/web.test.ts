import { afterEach, describe, expect, it, vi } from 'vitest';
import { webFetchTool, webSearchTool, resolveSearchProvider } from './web';
import type { ToolContext } from '../types';

function context(): ToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    stepId: 'st1',
    callId: 'c1',
    signal: new AbortController().signal,
    emit: { durable: () => undefined, live: () => undefined },
    mcp: {
      connected: false,
      studioLinked: false,
      server: { source: 'none', path: null, version: null },

      studio: null,
      toolCount: 0,
      lastError: null,
      listTools: async () => [],
      callTool: async () => null,
      reconnect: async () => undefined,
      // Task 31 shutdown contract: the test stub has nothing to release.
      close: async () => undefined,
    },
  };
}

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function response(status: number, contentType: string, body: string): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function mockFetch(response: MockResponse): void {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

function jsonResponse(body: unknown): MockResponse {
  return response(200, 'application/json', JSON.stringify(body));
}

function htmlResponse(body: string): MockResponse {
  return response(200, 'text/html; charset=utf-8', body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MORPHI_WEB_SEARCH_PROVIDER;
  delete process.env.BRAVE_API_KEY;
});

describe('web_fetch', () => {
  it('is an ask-gated, concurrency-safe, medium-risk internet tool', () => {
    expect(webFetchTool.name).toBe('web_fetch');
    expect(webFetchTool.approval).toBe('ask');
    expect(webFetchTool.isConcurrencySafe).toBe(true);
    expect(webFetchTool.presentation).toEqual({ label: 'Truy cập trang web', risk: 'medium' });
  });

  it('rejects a non-http url without calling the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = (await webFetchTool.execute({ url: 'file:///etc/passwd' }, context())) as { error: string };
    expect(result.error).toBe('INVALID_URL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing url', async () => {
    const result = (await webFetchTool.execute({}, context())) as { error: string };
    expect(result.error).toBe('INVALID_URL');
  });

  it('returns cleaned text from an html page', async () => {
    mockFetch(
      htmlResponse(
        '<html><head><title>x</title></head><body><script>var a=1;</script><p>Hello &amp; welcome to <b>Morphi</b>.</p></body></html>',
      ),
    );
    const result = (await webFetchTool.execute({ url: 'https://example.com/page' }, context())) as {
      url: string;
      contentType: string;
      text: string;
    };
    expect(result.url).toBe('https://example.com/page');
    expect(result.contentType).toContain('text/html');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('&'); // decoded
    expect(result.text).not.toContain('<script>');
  });

  it('pretty-prints json bodies', async () => {
    mockFetch(jsonResponse({ a: 1, b: [2, 3] }));
    const result = (await webFetchTool.execute({ url: 'https://api.example.com/d' }, context())) as { text: string };
    expect(result.text).toContain('"a": 1');
  });

  it('truncates to maxChars and reports the cap', async () => {
    mockFetch(htmlResponse('word '.repeat(5000)));
    const result = (await webFetchTool.execute({ url: 'https://example.com', maxChars: 100 }, context())) as {
      chars: number;
      text: string;
    };
    expect(result.chars).toBeLessThanOrEqual(100 + 40);
    expect(result.text).toContain('(truncated at 100 characters)');
  });

  it('reports a non-ok http status as an error result, not a throw', async () => {
    mockFetch(response(404, 'text/plain', 'nf'));
    const result = (await webFetchTool.execute({ url: 'https://example.com/missing' }, context())) as {
      error: string;
      status: number;
    };
    expect(result.error).toBe('HTTP_ERROR');
    expect(result.status).toBe(404);
  });
});

describe('web_search', () => {
  it('is an ask-gated, concurrency-safe, medium-risk internet tool', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.approval).toBe('ask');
    expect(webSearchTool.isConcurrencySafe).toBe(true);
    expect(webSearchTool.presentation).toEqual({ label: 'Tìm kiếm web', risk: 'medium' });
  });

  it('rejects an empty query', async () => {
    const result = (await webSearchTool.execute({ query: '   ' }, context())) as { error: string };
    expect(result.error).toBe('INVALID_QUERY');
  });

  it('reports graceful degradation when the provider is disabled', async () => {
    process.env.MORPHI_WEB_SEARCH_PROVIDER = 'none';
    const result = (await webSearchTool.execute({ query: 'roblox luau' }, context())) as {
      configured: boolean;
      results: unknown[];
    };
    expect(result.configured).toBe(false);
    expect(result.results).toEqual([]);
  });

  it('returns results from the key-less DuckDuckGo fallback by default', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        Heading: 'Luau',
        AbstractText: 'Luau is a scripting language.',
        AbstractURL: 'https://luau.org',
        RelatedTopics: [
          { Text: 'Roblox - uses Luau', FirstURL: 'https://roblox.com' },
          { Text: 'no url here', FirstURL: '' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = (await webSearchTool.execute({ query: 'luau', limit: 5 }, context())) as {
      provider: string;
      count: number;
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(result.provider).toBe('duckduckgo');
    expect(result.count).toBe(2); // the second related topic has no URL and is dropped
    expect(result.results[0].url).toBe('https://luau.org');
    expect(result.results[1].url).toBe('https://roblox.com');
  });

  it('uses Brave when a key is configured and maps its payload', async () => {
    process.env.MORPHI_WEB_SEARCH_PROVIDER = 'brave';
    process.env.BRAVE_API_KEY = 'test-key';
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ web: { results: [{ title: 'T', url: 'https://t.co', description: 'D' }] } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = (await webSearchTool.execute({ query: 'x' }, context())) as {
      provider: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(result.provider).toBe('brave');
    expect(result.results).toEqual([{ title: 'T', url: 'https://t.co', snippet: 'D' }]);
    const callArgs = fetchSpy.mock.calls[0] as unknown[];
    expect(String(callArgs[0])).toContain('api.search.brave.com');
  });

  it('surfaces a provider failure as an error result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500, 'application/json', '{}')));
    const result = (await webSearchTool.execute({ query: 'x' }, context())) as { error: string };
    expect(result.error).toBe('SEARCH_FAILED');
  });
});

describe('resolveSearchProvider', () => {
  it('defaults to the key-less DuckDuckGo provider', () => {
    delete process.env.MORPHI_WEB_SEARCH_PROVIDER;
    expect(resolveSearchProvider()?.name).toBe('duckduckgo');
  });

  it('returns null when set to none', () => {
    process.env.MORPHI_WEB_SEARCH_PROVIDER = 'none';
    expect(resolveSearchProvider()).toBeNull();
  });

  it('returns null for brave without a key', () => {
    process.env.MORPHI_WEB_SEARCH_PROVIDER = 'brave';
    delete process.env.BRAVE_API_KEY;
    expect(resolveSearchProvider()).toBeNull();
  });

  it('returns brave when a key is present', () => {
    process.env.MORPHI_WEB_SEARCH_PROVIDER = 'brave';
    process.env.BRAVE_API_KEY = 'k';
    expect(resolveSearchProvider()?.name).toBe('brave');
  });
});
