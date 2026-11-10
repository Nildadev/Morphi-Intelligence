import type { TokenUsage } from '../shared/types';
import { createId } from '../shared/id';
import { parseSSEChunk } from './sse';
import { errorDetail } from './errorDetail';
import type { LlmMessage, LlmRequest, ModelInfo, ProviderAdapter, ReasoningEffort, StreamEvent } from './types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDER_LABEL = 'Google AI Studio';

/**
 * Gemini model families whose output is not chat text even though some also
 * accept `generateContent` (TTS speaks audio, `*-image` paints pictures,
 * Veo/Lyria produce video/music). The picker only takes text-output models.
 */
const NON_TEXT_OUTPUT = /imagen|veo|lyria|tts|audio|video|\-image|embedding|embed/;

/** Levels every thinking Gemini model accepts; the API itself decides which models get them. */
const GEMINI_EFFORTS = ['low', 'medium', 'high'] as const;
/** `thinkingBudget` in tokens. `high` is Gemini's own dynamic ceiling for 2.5 models;
 *  the other levels exist to satisfy the shared `ReasoningEffort` type (Gemini models only
 *  declare `low/medium/high`, so those rows never reach the wire). */
const GEMINI_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 512, low: 1_024, medium: 8_192, high: 24_576, xhigh: 32_768, max: 65_536,
};

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string | null;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function stripModelsPrefix(name: string): string {
  return name.replace(/^models\//, '');
}

/**
 * Gemini's `functionDeclarations.parameters` is a restricted JSON-Schema subset: unknown
 * keywords such as `additionalProperties` make the whole request 400 (INVALID_ARGUMENT),
 * aborting every tool call on Gemini 3.x. Our registry schemas carry `additionalProperties`
 * (Ajv-faithful OpenAI shape), so strip it recursively — it only ever constrained
 * validation, never added a field.
 */
function stripAdditionalProperties(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
  if (schema !== null && typeof schema === 'object') {
    return Object.fromEntries(
      Object.entries(schema as Record<string, unknown>)
        .filter(([key]) => key !== 'additionalProperties')
        .map(([key, value]) => [key, stripAdditionalProperties(value)]),
    );
  }
  return schema;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'google';
  readonly name = PROVIDER_LABEL;
  private apiKey: string | undefined;

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      throw new Error('Gemini API key is not set');
    }

    const response = await fetch(`${BASE_URL}/models?key=${this.apiKey}`);
    if (!response.ok) {
      throw new Error(`Failed to list models: HTTP ${response.status} ${response.statusText}`.trim());
    }

    const payload = (await response.json()) as {
      models?: Array<{
        name?: unknown;
        displayName?: unknown;
        inputTokenLimit?: unknown;
        supportedGenerationMethods?: unknown;
        /** Gemini 2.5+ reports whether the model can think before answering. */
        thinking?: unknown;
      }>;
    };

    return (payload.models ?? []).flatMap((model) => {
      if (typeof model.name !== 'string') return [];
      const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) return [];
      const id = stripModelsPrefix(model.name);
      // Text-output only: image/video/audio/music families never answer a chat turn, even
      // when the API lets them ride `generateContent` (TTS, `*-image` painters, …).
      if (NON_TEXT_OUTPUT.test(id.toLowerCase())) return [];
      return [{
        id,
        name: typeof model.displayName === 'string' && model.displayName ? model.displayName : id,
        provider: 'google',
        providerLabel: PROVIDER_LABEL,
        ...(typeof model.inputTokenLimit === 'number' ? { context: model.inputTokenLimit } : {}),
        // Only what the API declared: no `thinking` flag means no effort selector, not a guess.
        ...(model.thinking === true ? { efforts: [...GEMINI_EFFORTS] } : {}),
        supportsTools: id.startsWith('gemini-'),
      }];
    });
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    if (request.signal.aborted) {
      yield { type: 'finish', reason: 'cancelled' };
      return;
    }

    if (!this.apiKey) {
      yield {
        type: 'error',
        error: { code: 'missing_api_key', message: 'Gemini API key is not set', retryable: false },
      };
      yield { type: 'finish', reason: 'error' };
      return;
    }

    let response: Response;
    try {
      response = await fetch(this.streamUrl(request.model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.requestBody(request)),
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
      // Gemini answers `{ "error": { "code": 400, "message": "...", "status": "..." } }`; the flat
      // `message` shape is shared with the OpenAI-compatible gateways, so one helper serves both.
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
    let finishReason: string | null | undefined;
    let usage: TokenUsage | undefined;
    let emittedToolCall = false;
    let rest = '';

    const payloadEvents = (payload: string): StreamEvent[] => {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(payload) as GeminiChunk;
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
      const metadata = chunk.usageMetadata;
      if (metadata) {
        const promptTokens = metadata.promptTokenCount ?? 0;
        const completionTokens = metadata.candidatesTokenCount ?? 0;
        usage = {
          promptTokens,
          completionTokens,
          totalTokens: metadata.totalTokenCount ?? promptTokens + completionTokens,
        };
      }

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought === true) {
          if (part.text) events.push({ type: 'reasoning_delta', text: part.text });
        } else if (part.text) {
          events.push({ type: 'text_delta', text: part.text });
        }

        if (part.functionCall) {
          const callId = createId('call');
          const name = part.functionCall.name ?? '';
          emittedToolCall = true;
          events.push({ type: 'tool_call_start', callId, name });
          events.push({ type: 'tool_call_end', callId, name, args: part.functionCall.args ?? {} });
        }
      }

      if (candidate?.finishReason) finishReason = candidate.finishReason;
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

        if (finishReason) break;
        if (read.done) break;
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

    if (usage) yield { type: 'usage', usage };

    yield { type: 'finish', reason: finish(emittedToolCall, finishReason) };
  }

  private streamUrl(model: string): string {
    const id = encodeURIComponent(stripModelsPrefix(model));
    const key = encodeURIComponent(this.apiKey ?? '');
    return `${BASE_URL}/models/${id}:streamGenerateContent?alt=sse&key=${key}`;
  }

  /**
   * Thinking budgets in tokens. `low` still thinks (a little), because a user who picked a level
   * wants reasoning, not a disabled switch; `high` matches Gemini's own "dynamic" ceiling band.
   */
  private thinkingConfig(effort: ReasoningEffort): Record<string, unknown> {
    return { thinkingBudget: GEMINI_THINKING_BUDGET[effort], includeThoughts: true };
  }

  private requestBody(request: LlmRequest): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {};
    if (request.effort) generationConfig.thinkingConfig = this.thinkingConfig(request.effort);
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    const body: Record<string, unknown> = {
      contents: this.contents(request.messages),
      generationConfig,
    };

    const systemPrompts = request.messages.filter((message) => message.role === 'system');
    if (systemPrompts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemPrompts.map((message) => message.content).join('\n\n') }] };
    }

    if (request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: stripAdditionalProperties(tool.parameters),
        })),
      }];
    }

    return body;
  }

  private contents(messages: LlmMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    const callNames = new Map<string, string>();
    let lastWasTool = false;

    for (const message of messages) {
      if (message.role === 'system') continue;

      if (message.role === 'user') {
        // Vision turns carry the pixels as inlineData parts; an image-only message skips the empty
        // text part, while a plain text turn keeps its byte-identical single-part shape.
        const parts: GeminiPart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const image of message.imageParts ?? []) {
          parts.push({ inlineData: { mimeType: image.mime, data: image.data } });
        }
        if (parts.length === 0) parts.push({ text: '' });
        contents.push({ role: 'user', parts });
        lastWasTool = false;
        continue;
      }

      if (message.role === 'assistant') {
        const toolCalls = message.toolCalls ?? [];
        for (const call of toolCalls) callNames.set(call.id, call.name);

        const parts: GeminiPart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of toolCalls) {
          parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
        }
        if (parts.length === 0) {
          lastWasTool = false;
          continue;
        }

        contents.push({ role: 'model', parts });
        lastWasTool = false;
        continue;
      }

      const callId = message.toolCallId ?? '';
      const part: GeminiPart = {
        functionResponse: {
          name: callNames.get(callId) ?? callId,
          response: { result: message.content },
        },
      };
      if (lastWasTool) {
        contents[contents.length - 1].parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
        lastWasTool = true;
      }
    }

    return contents;
  }
}

function finish(emittedToolCall: boolean, reason: string | null | undefined): 'stop' | 'length' | 'tool_calls' {
  if (emittedToolCall) return 'tool_calls';
  if (reason === 'MAX_TOKENS') return 'length';
  return 'stop';
}
