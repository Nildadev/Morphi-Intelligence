import type { TokenUsage } from '../shared/types';
import { parseSSEChunk } from './sse';
import { errorDetail } from './errorDetail';
import type { LlmMessage, LlmRequest, ModelInfo, ProviderAdapter, ReasoningEffort, StreamEvent, ToolSchema } from './types';
import { PROVIDER_CATALOG, CATALOG_AUTHORITY, type CatalogModel } from './providerCatalog';

/**
 * Name fallback for catalogues that declare no output modality: model families
 * whose output is never chat text (embeddings, speech, posters). Only used
 * when `architecture.output_modalities` is absent; a declared modality always
 * wins (so `gpt-image-1` with `output_modalities: ['text']` stays).
 */
const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|image|flux|veo|sora|kling|recraft|midjourney|audio|speech|lyria|music|video|diffusion|rerank/;

interface RawToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: RawToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

interface ToolCallAccumulator {
  callId: string;
  name: string;
  args: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Studio tools are published as `studio.<name>` (`harness/tools/registry.ts` publishes the MCP half
 * under that prefix), and OpenAI-compatible function names only allow `[a-zA-Z0-9_-]`:
 * Anthropic-through-OpenRouter answers a dotted name with
 * `Function at index 21 has an invalid name: "studio.upload_image"` and a 400 that kills the turn.
 *
 * So the wire gets a safe alias (`studio.upload_image` → `studio_upload_image`) and everything the
 * provider says about tools is translated back through `real()` before it leaves the adapter: the
 * pipeline and the UI keep seeing the real name.
 *
 * Collisions are resolved with a numeric suffix, because two Studio servers could legitimately
 * publish `a.b` and `a_b` and silently merging them would call the wrong tool.
 */
interface ToolNameCodec {
  /** The safe name the provider sees. */
  wire(name: string): string;
  /** The real studio/pipeline name, back from what the provider said. */
  real(name: string): string;
}

const WIRE_NAME_ALLOWED = /[^a-zA-Z0-9_-]/g;
const WIRE_NAME_MAX = 128;

function createToolNameCodec(tools: readonly ToolSchema[]): ToolNameCodec {
  const toWire = new Map<string, string>();
  const toReal = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools) {
    if (toWire.has(tool.name)) continue;
    const base = tool.name.replace(WIRE_NAME_ALLOWED, '_').slice(0, WIRE_NAME_MAX) || 'tool';
    let wire = base;
    let round = 1;
    while (used.has(wire)) {
      round += 1;
      wire = `${base}_${round}`;
    }
    used.add(wire);
    toWire.set(tool.name, wire);
    toReal.set(wire, tool.name);
  }
  return { wire: (name) => toWire.get(name) ?? name, real: (name) => toReal.get(name) ?? name };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'tool_calls' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  return 'stop';
}

/** Display order for the Composer slider: least to most effort. */
const EFFORT_ORDER: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private apiKey: string | undefined;
  /**
   * Bundled cards for a gateway whose own listing carries no metadata (NVIDIA NIM returns ids and
   * `owned_by` only; the DeepSeek web bridge at `127.0.0.1:8000` likewise). Two use modes,
   * decided by `catalogAuthority`:
   *  - authoritative: the wire's ids are only an availability check, the card decides everything
   *    (a live id without a card is not a chat model: embedder, safety guard, vision-only).
   *  - enriching: the wire row stands as-is and the card fills only what it omitted; a
   *    wire-declared fact always wins (see `enrich`).
   */
  private readonly catalog: ReadonlyMap<string, CatalogModel> | undefined;
  /** When true the wire carries ids alone, so a live id without a card is not a chat model. */
  private readonly catalogAuthority: boolean;

  constructor({ id, name, baseUrl, defaultHeaders }: {
    id: string;
    name: string;
    baseUrl: string;
    defaultHeaders?: Record<string, string>;
  }) {
    this.id = id;
    this.name = name;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.defaultHeaders = defaultHeaders ?? {};
    const cards = PROVIDER_CATALOG[id];
    this.catalog = cards === undefined ? undefined : new Map(cards.map((card) => [card.id, card]));
    // Authoritative only for the gateways whose wire carries ids alone; for everyone else the
    // cards enrich (a wire-declared fact still wins).
    this.catalogAuthority = CATALOG_AUTHORITY.has(id);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Failed to list models: HTTP ${response.status} ${response.statusText}`.trim());
    }

    const payload = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        context_length?: unknown;
        context_window?: unknown;
        architecture?: { output_modalities?: unknown; input_modalities?: unknown };
        supported_parameters?: unknown;
        supported_efforts?: unknown;
        reasoning?: { supported_efforts?: unknown };
      }>;
    };

    if (this.catalog) {
      // A gateway without a self-describing catalogue: keep the live listing only as the
      // availability check (ids), and let the bundled cards supply everything else.
      const liveIds: string[] = [];
      for (const model of payload.data ?? []) {
        if (typeof model.id === 'string') liveIds.push(model.id);
      }
      if (this.catalogAuthority) return this.catalogModels(liveIds);
    }

    return (payload.data ?? []).flatMap((model) => {
      if (typeof model.id !== 'string') return [];
      // Only text-output models reach the picker: image/audio/embedding models can never answer a
      // chat turn. Catalogues that state output modalities (OpenRouter) win; otherwise the
      // embedding/audio/image name pattern decides. A model that also paints images
      // (`['text', 'image']`) is still excluded — the list is text-only, nothing else.
      const modalities = Array.isArray(model.architecture?.output_modalities)
        ? model.architecture.output_modalities.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
      const textModel = modalities !== undefined
        ? modalities.length > 0 && modalities.every((entry) => entry === 'text')
        : !NON_CHAT_MODEL.test(model.id.toLowerCase());
      if (!textModel) return [];
      // Vision support: the catalogue states input modalities when it knows them (e.g. a
      // text+image -> text model). Unknown stays unknown (permissive), never a false refusal.
      const inputModalities = Array.isArray(model.architecture?.input_modalities)
        ? model.architecture.input_modalities.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
      const context =
        typeof model.context_length === 'number'
          ? model.context_length
          : typeof model.context_window === 'number'
            ? model.context_window
            : undefined;
      // Catalogues that state their capabilities (OpenRouter's `supported_parameters`) win over
      // the name heuristic: a model whose endpoints never accept `tools` must say so here, or the
      // harness will send tool definitions and the router 404s on tool compatibility.
      const supported = Array.isArray(model.supported_parameters)
        ? model.supported_parameters.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
      // The catalogues declare reasoning support — OpenRouter at `reasoning.supported_efforts`
      // (e.g. stealth/crouton-alpha: max/xhigh/high/medium/low/minimal) and some at top-level
      // `supported_efforts`. What the selector offers is exactly what they declared, verbatim
      // (only re-ordered least-to-most for the slider) — never filtered or guessed by name.
      const declaredRaw = Array.isArray(model.reasoning?.supported_efforts)
        ? model.reasoning.supported_efforts
        : Array.isArray(model.supported_efforts)
          ? model.supported_efforts
          : undefined;
      const efforts = declaredRaw === undefined
        ? undefined
        : EFFORT_ORDER.filter((level) => declaredRaw.includes(level));
      const card = this.catalog?.get(model.id);
      return [{
        id: model.id,
        name: model.id,
        provider: this.id,
        providerLabel: this.name,
        ...(context === undefined ? {} : { context }),
        ...(efforts === undefined ? {} : { efforts }),
        supportsTools: supported !== undefined
          ? supported.includes('tools')
          : !NON_CHAT_MODEL.test(model.id.toLowerCase()),
        ...(inputModalities !== undefined ? { supportsImages: inputModalities.includes('image') } : {}),
      }].map((entry) => this.enrich(entry, card));
    });
  }

  /**
   * Fill the gaps a wire row leaves behind from the bundled card (NIM/Kilo answer with ids and
   * `owned_by` only, so context, name and efforts come from models.dev). A wire-declared fact
   * always wins — the card only ever adds what the wire omitted, so a gateway that renamed a
   * model keeps its own context instead of the card's.
   */
  private enrich(model: ModelInfo, card: CatalogModel | undefined): ModelInfo {
    if (card === undefined) return model;
    return {
      ...model,
      name: card.name,
      ...(model.context === undefined && card.context !== undefined ? { context: card.context } : {}),
      ...(model.efforts === undefined && card.efforts !== undefined ? { efforts: card.efforts } : {}),
      supportsTools: card.tools,
      ...(card.images === undefined
        ? {}
        : model.supportsImages === undefined
          ? { supportsImages: card.images }
          : {}),
    };
  }

  /**
   * Catalog-backed line-up. The live listing decides which cards are offered (an account can be
   * gated from a model the catalogue knows), and the card decides everything else. A listing that
   * shares no id with the catalogue is a gateway that renames its models: the whole catalogue then
   * stands rather than showing an empty picker for a key that just listed models fine.
   */
  private catalogModels(liveIds: readonly string[]): ModelInfo[] {
    const cards = [...(this.catalog?.values() ?? [])];
    const offered = cards.filter((card) => liveIds.includes(card.id));
    const list = offered.length > 0 ? offered : cards;
    return list.map((card) => ({
      id: card.id,
      name: card.name,
      provider: this.id,
      providerLabel: this.name,
      ...(card.context === undefined ? {} : { context: card.context }),
      ...(card.efforts === undefined ? {} : { efforts: card.efforts }),
      supportsTools: card.tools,
      ...(card.images === undefined ? {} : { supportsImages: card.images }),
    }));
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    if (request.signal.aborted) {
      yield { type: 'finish', reason: 'cancelled' };
      return;
    }

    let response: Response;
    // The alias table is per request: the provider only ever sees safe names, and every name it
    // says back is translated to the real one.
    const codec = createToolNameCodec(request.tools);
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.requestBody(request, codec)),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      yield { type: 'error', error: { code: 'stream_error', message: errorMessage(error), retryable: true } };
      yield { type: 'finish', reason: 'error' };
      return;
    }

    if (!response.ok) {
      // The provider's own sentence, lifted out of its envelope: the user reads "Validation:
      // Function at index 21 has an invalid name", not a raw JSON blob.
      const body = await response.text().catch(() => '');
      yield {
        type: 'error',
        error: {
          code: 'http_error',
          message: errorDetail(body, response.status, response.statusText),
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        },
      };
      yield { type: 'finish', reason: 'error' };
      return;
    }

    if (!response.body) {
      yield {
        type: 'error',
        error: { code: 'stream_error', message: 'Response body is empty', retryable: false },
      };
      yield { type: 'finish', reason: 'error' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason: string | null | undefined;
    let rest = '';
    let done = false;

    const payloadEvents = (payload: string): StreamEvent[] => {
      let chunk: RawChunk;
      try {
        chunk = JSON.parse(payload) as RawChunk;
      } catch (error) {
        return [
          {
            type: 'error',
            error: {
              code: 'stream_error',
              message: `Malformed stream payload: ${errorMessage(error)}`,
              retryable: false,
            },
          },
          { type: 'finish', reason: 'error' },
        ];
      }

      const events: StreamEvent[] = [];
      if (chunk.usage) {
        const promptTokens = chunk.usage.prompt_tokens ?? 0;
        const completionTokens = chunk.usage.completion_tokens ?? 0;
        events.push({
          type: 'usage',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: chunk.usage.total_tokens ?? promptTokens + completionTokens,
          } satisfies TokenUsage,
        });
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) events.push({ type: 'reasoning_delta', text: reasoning });
        if (delta.content) events.push({ type: 'text_delta', text: delta.content });

        for (const entry of delta.tool_calls ?? []) {
          const index = entry.index ?? 0;
          let call = toolCalls.get(index);
          if (!call) {
            call = { callId: entry.id ?? '', name: codec.real(entry.function?.name ?? ''), args: '' };
            toolCalls.set(index, call);
            events.push({ type: 'tool_call_start', callId: call.callId, name: call.name });
          } else if (entry.function?.name) {
            call.name += entry.function.name;
          }

          const argsDelta = entry.function?.arguments ?? '';
          if (argsDelta) {
            call.args += argsDelta;
            events.push({ type: 'tool_call_delta', callId: call.callId, argsDelta });
          }
        }
      }

      if (choice?.finish_reason) finishReason = choice.finish_reason;
      return events;
    };

    try {
      while (true) {
        if (request.signal.aborted) {
          yield { type: 'finish', reason: 'cancelled' };
          return;
        }

        const read = await reader.read();
        const text = read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
        const parsed = parseSSEChunk(rest, text, read.done);
        rest = parsed.rest;

        for (const payload of parsed.data) {
          if (payload === '[DONE]') {
            done = true;
            break;
          }
          if (!payload) continue;

          const events = payloadEvents(payload);
          for (const event of events) {
            if (request.signal.aborted) {
              yield { type: 'finish', reason: 'cancelled' };
              return;
            }
            yield event;
          }
          if (events.some((event) => event.type === 'finish')) return;
        }

        if (finishReason) done = true;
        if (done || read.done) break;
      }
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }
      yield { type: 'error', error: { code: 'stream_error', message: errorMessage(error), retryable: true } };
      yield { type: 'finish', reason: 'error' };
      return;
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (request.signal.aborted) {
      yield { type: 'finish', reason: 'cancelled' };
      return;
    }

    for (const call of toolCalls.values()) {
      let args: unknown = {};
      if (call.args.trim()) {
        try {
          args = JSON.parse(call.args);
        } catch {
          args = {};
        }
      }
      yield { type: 'tool_call_end', callId: call.callId, name: codec.real(call.name), args };
    }

    yield { type: 'finish', reason: mapFinishReason(finishReason) };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private requestBody(request: LlmRequest, codec: ToolNameCodec): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      messages: request.messages.map((message) => this.apiMessage(message, codec)),
      // Deepseek `prepareCall` pattern: an explicit output cap prevents routers (OpenRouter)
      // from charging for the model's full context as `max_tokens` — the 402 “requires more
      // credits, or fewer max_tokens” when an affordable balance cannot cover 65536.
      max_tokens: request.maxTokens ?? 8192,
    };
    // Only when the caller picked a level. OpenAI-compatible servers that do not know the field
    // ignore it; the ones that do (o-series, gpt-5) honour it.
    if (request.effort) body.reasoning_effort = request.effort;
    // The local DeepSeek web bridge (server/config.py) has no effort ladder: reasoning is a
    // boolean `thinking` toggle. It accepts `reasoning_effort` (pydantic ignores the unknown
    // field), so translate a picked level into "DeepThink on" rather than sending a field that
    // does nothing. `low`/`minimal` stay off — the fast default mode is the sane "less thinking".
    if (this.id === 'deepseek-chat' && request.effort && request.effort !== 'minimal' && request.effort !== 'low') {
      body.thinking = true;
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: codec.wire(tool.name), description: tool.description, parameters: tool.parameters },
      }));
    }
    return body;
  }

  private apiMessage(message: LlmMessage, codec: ToolNameCodec): Record<string, unknown> {
    const mapped: Record<string, unknown> = { role: message.role };
    // Vision turns carry the images as content parts; everything else keeps the string shape so
    // text-only requests stay byte-identical to before.
    if (message.imageParts && message.imageParts.length > 0) {
      mapped.content = [
        { type: 'text', text: message.content },
        ...message.imageParts.map((part) => ({
          type: 'image_url',
          image_url: { url: `data:${part.mime};base64,${part.data}` },
        })),
      ];
    } else {
      mapped.content = message.content;
    }
    if (message.toolCallId !== undefined) mapped.tool_call_id = message.toolCallId;
    if (message.toolCalls && message.toolCalls.length > 0) {
      mapped.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        // Same alias as the tool list: an assistant echo with a dotted name would be rejected too.
        function: { name: codec.wire(call.name), arguments: JSON.stringify(call.args ?? {}) },
      }));
    }
    return mapped;
  }
}
