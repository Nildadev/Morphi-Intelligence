import type { ToolDefinition, ToolContext } from '../types';

/**
 * Built-in internet tools (Task 31): let the agent fetch a web page's readable text and run a web
 * search for research. Both are read-only, concurrency-safe and gated behind approval so they only
 * fire when the user's permission mode allows internet use (every mode except "full" prompts first).
 *
 * `web_search` is provider-based and degrades gracefully:
 *  - `MORPHI_WEB_SEARCH_PROVIDER=brave` (or any non-empty value) uses Brave Search and needs
 *    `BRAVE_API_KEY`. Set that for real, deep research.
 *  - With no provider configured it falls back to DuckDuckGo's key-less Instant Answer API so the
 *    tool still works out of the box for lightweight lookups.
 *  - `MORPHI_WEB_SEARCH_PROVIDER=none` disables search entirely; the tool reports that instead of
 *    throwing, so the model can explain the limitation and move on.
 */

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 24_000;
const SEARCH_TIMEOUT_MS = 20_000;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Only http(s) URLs are accepted — no file:, ftp:, or other schemes reach the network. */
function parseHttpUrl(raw: unknown): URL | null {
  const value = asString(raw)?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

/**
 * Best-effort HTML → plain text: drop scripts/styles/comments, strip tags and decode the common
 * entities. Not a renderer — just enough to feed the model the page's prose without markup noise.
 */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const noTags = stripped.replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#0*34;/gi, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
  return decoded.replace(/\s+/g, ' ').trim();
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch a public web page by URL and return its readable text content for research. Use it to read ' +
    'articles, documentation, or any http(s) page the user asks about. Returns the cleaned text ' +
    '(HTML is converted to prose; JSON is pretty-printed) and the detected content type.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The fully-qualified http(s) URL to fetch.' },
      maxChars: {
        type: 'integer',
        description: 'Optional cap on returned characters (default 24000, max 100000).',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(args, ctx: ToolContext): Promise<unknown> {
    const url = parseHttpUrl((args as { url?: unknown } | null | undefined)?.url);
    if (!url) {
      return { error: 'INVALID_URL', message: 'Provide a valid http(s) URL in the "url" field.' };
    }
    const maxChars = asPositiveInt((args as { maxChars?: unknown }).maxChars, DEFAULT_MAX_CHARS, 100_000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    if (ctx.signal.aborted) controller.abort();
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Morphi/1.0 (+https://morphi.ai; research agent)',
          Accept: 'text/html, application/json, application/xml, text/plain, */*',
        },
      });
      if (!response.ok) {
        return {
          error: 'HTTP_ERROR',
          status: response.status,
          url: url.toString(),
          message: `Request failed with HTTP ${response.status}.`,
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();

      let text: string = raw;
      if (contentType.includes('application/json')) {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      } else if (contentType.includes('html')) {
        text = htmlToText(raw);
      }

      const truncated =
        text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters)` : text;
      return { url: url.toString(), contentType, chars: truncated.length, text: truncated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: 'FETCH_FAILED', url: url.toString(), message };
    } finally {
      clearTimeout(timer);
    }
  },
  isConcurrencySafe: true,
  approval: 'ask',
  presentation: { label: 'Truy cập trang web', risk: 'medium' },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchProvider {
  name: string;
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]>;
}

function makeBraveProvider(apiKey: string): SearchProvider {
  return {
    name: 'brave',
    async search(query, limit, signal) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
        query,
      )}&count=${limit}`;
      const response = await fetch(url, {
        signal,
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      });
      if (!response.ok) {
        throw new Error(`Brave Search returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const items = data.web?.results ?? [];
      return items
        .slice(0, limit)
        .map((item) => ({ title: item.title ?? '', url: item.url ?? '', snippet: item.description ?? '' }))
        .filter((result) => result.url.length > 0);
    },
  };
}

function makeDuckDuckGoProvider(): SearchProvider {
  return {
    name: 'duckduckgo',
    async search(query, limit, signal) {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
        query,
      )}&format=json&no_html=1&skip_disambig=1`;
      const response = await fetch(url, {
        signal,
        headers: { 'User-Agent': 'Morphi/1.0 (research agent)', Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const results: SearchResult[] = [];
      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading || 'Abstract',
          url: data.AbstractURL,
          snippet: data.AbstractText,
        });
      }
      for (const topic of data.RelatedTopics ?? []) {
        if (results.length >= limit) break;
        if (topic.FirstURL && topic.Text) {
          const title = topic.Text.split(' - ')[0]?.trim() || topic.Text;
          results.push({ title, url: topic.FirstURL, snippet: topic.Text });
        }
      }
      return results;
    },
  };
}

/**
 * Resolve the search provider from the environment. Brave takes priority when its key is present;
 * otherwise DuckDuckGo's key-less API is used so search works without any setup; `none` disables it.
 */
export function resolveSearchProvider(): SearchProvider | null {
  const choice = (process.env.MORPHI_WEB_SEARCH_PROVIDER ?? 'duckduckgo').toLowerCase();
  if (choice === 'none') return null;
  if (choice === 'brave') {
    const key = process.env.BRAVE_API_KEY;
    if (!key) return null;
    return makeBraveProvider(key);
  }
  return makeDuckDuckGoProvider();
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for a query and return a list of result links with titles and snippets for ' +
    'research. Use it to look up current facts, docs or references the user asks about. Returns up ' +
    'to `limit` results; set BRAVE_API_KEY (or MORPHI_WEB_SEARCH_PROVIDER) for deeper coverage.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      limit: { type: 'integer', description: 'Maximum number of results to return (default 8, max 20).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(args, ctx: ToolContext): Promise<unknown> {
    const query = asString((args as { query?: unknown } | null | undefined)?.query)?.trim();
    if (!query) {
      return { error: 'INVALID_QUERY', message: 'Provide a non-empty "query".' };
    }
    const limit = asPositiveInt((args as { limit?: unknown }).limit, 8, 20);
    const provider = resolveSearchProvider();
    if (!provider) {
      return {
        configured: false,
        provider: 'none',
        query,
        results: [],
        message:
          'Web search is not configured. Set BRAVE_API_KEY (or MORPHI_WEB_SEARCH_PROVIDER=brave) for ' +
          'real search, or leave it unset to use the key-less DuckDuckGo fallback.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    if (ctx.signal.aborted) controller.abort();
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const results = await provider.search(query, limit, controller.signal);
      return { query, provider: provider.name, count: results.length, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: 'SEARCH_FAILED', query, provider: provider.name, message, results: [] };
    } finally {
      clearTimeout(timer);
    }
  },
  isConcurrencySafe: true,
  approval: 'ask',
  presentation: { label: 'Tìm kiếm web', risk: 'medium' },
};
