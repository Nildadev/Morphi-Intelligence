import type { JsonSchema, TokenUsage } from '../shared/types';

export interface ToolSchema { name: string; description: string; parameters: JsonSchema; }
export interface LlmToolCall { id: string; name: string; args: unknown; }
export interface LlmMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: LlmToolCall[]; reasoning?: string; /** Base64 image parts for vision models, attached by the loop when the turn carried image attachments. */ imageParts?: Array<{ mime: string; data: string }>; }
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; callId: string; name: string }
  | { type: 'tool_call_delta'; callId: string; argsDelta: string }
  | { type: 'tool_call_end'; callId: string; name: string; args: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled' }
  | { type: 'error'; error: { code: string; message: string; retryable: boolean; status?: number } };
export interface LlmRequest { model: string; messages: LlmMessage[]; tools: ToolSchema[]; /** Omitted when the user did not pick a level. */ effort?: ReasoningEffort; /** Output cap sent to the provider; when omitted the adapter applies a safe default. */ maxTokens?: number; signal: AbortSignal; }
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  setApiKey?(apiKey: string): void;
  setBaseUrl?(baseUrl: string): void;
  listModels(): Promise<ModelInfo[]>;
  stream(request: LlmRequest): AsyncIterable<StreamEvent>;
}
/**
 * How hard a model should think before answering. Only meaningful for models that declare
 * `efforts`; for the rest the selector is not offered at all (Task 31C). The values mirror
 * what catalogues declare (`reasoning.supported_efforts`, e.g. max/xhigh/high/medium/low/
 * minimal on stealth/crouton-alpha) — never narrowed down by guessing.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  context?: number;
  /** Levels this model accepts. Absent means it has no reasoning knob - not "unknown". */
  efforts?: ReasoningEffort[];
  supportsTools: boolean;
  /** Image input support from the catalogue. Absent means unknown (permissive, not "no"). */
  supportsImages?: boolean;
}
