export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number; }

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
}

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'waiting_approval' | 'cancelled';

/**
 * How the client wants tool calls approved this turn. It is the global override the per-tool
 * `approval` field (auto/ask/ask-once) and the high-risk-always-asks rule are resolved against:
 * - `ask`: every tool must be approved (the most conservative setting).
 * - `balanced`: respect each tool's own `approval` field; high risk always asks. This is the default
 *   and the historical behaviour, so omitting the field changes nothing.
 * - `full`: unrestricted — no approval prompt is ever shown, even for high-risk calls.
 */
export type PermissionMode = 'ask' | 'balanced' | 'full';

/** The default when the client sends no mode; identical to the pre-permission-mode behaviour. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'balanced';

export type LiveEvent =
  | { type: 'assistant/delta'; payload: { turnId: string; text: string } }
  | { type: 'thought/delta'; payload: { turnId: string; text: string } }
  | { type: 'tool/progress'; payload: { callId: string; message: string } }
  | { type: 'agent/status'; payload: { state: AgentStatus; turnId?: string } }
  | { type: 'mcp/status'; payload: { connected: boolean; studioLinked: boolean } }
  | { type: 'error'; payload: { code: string; message: string; retryable: boolean } };
