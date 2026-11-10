import type { Emit } from '../events/types';
import type { ToolSchema } from '../llm/types';
import type { JsonSchema } from '../shared/types';
import type { PermissionMode } from '../shared/types';

export interface ToolContext {
  sessionId: string;
  turnId: string;
  stepId: string;
  callId: string;
  signal: AbortSignal;
  emit: Emit;
  mcp: McpGateway;
}

export type McpSource = 'settings' | 'studio-builtin' | 'studio-binary' | 'none';

export interface McpGateway {
  readonly connected: boolean;
  readonly studioLinked: boolean;
  readonly server: { source: McpSource; path: string | null; version: string | null };
  /** Task 31C Step 1: what the status payload may claim about the live place. */
  readonly studio: { id: string; name: string | null } | null;
  readonly toolCount: number;
  readonly lastError: { code: string; message: string } | null;
  listTools(): Promise<ToolSchema[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  reconnect(): Promise<void>;
  /** Task 31: releases the Studio MCP child on app shutdown (Task 17 review Minor 7). */
  close(): Promise<void>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
  timeoutMs?: number;
  /** Hard cap on returned characters for this tool; the turn's window budget still applies. */
  maxOutputChars?: number;
  isConcurrencySafe: boolean;
  approval: 'auto' | 'ask' | 'ask-once';
  presentation: { label: string; risk: 'low' | 'medium' | 'high' };
}

/** Everything a turn-level caller can know before a specific call is dispatched. */
/**
 * Turn-level context. `outputBudgetChars` is how many characters one tool result may return in THIS
 * turn's model window (Task 31C); absent means the flat ceiling, which only tests rely on.
 */
export type ToolRunContext = Omit<ToolContext, 'callId'> & {
  outputBudgetChars?: number;
  /** Global approval override for this turn; absent means the default (`balanced`). */
  permissionMode?: PermissionMode;
};

export type ToolResultStatus = 'done' | 'error' | 'cancelled';

/** One image a tool produced, bound for a vision model out-of-band (never the event log). */
export interface ToolImage {
  mime: string;
  data: string;
}

/**
 * Tool output convention: `{ text, images }` persists only `text`; the pixels ride the turn's next
 * request on a user message (chat-completions tool messages are text-only). Any other shape — even
 * an `images` key with malformed entries — stays an ordinary structured result.
 */
export interface ToolImageOutput {
  text: string;
  images: ToolImage[];
}

export function isToolImageOutput(value: unknown): value is ToolImageOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { text?: unknown; images?: unknown };
  if (typeof record.text !== 'string' || !Array.isArray(record.images) || record.images.length === 0) return false;
  return record.images.every((image) =>
    Boolean(image) && typeof image === 'object'
    && typeof (image as ToolImage).mime === 'string'
    && typeof (image as ToolImage).data === 'string'
    && (image as ToolImage).data.length > 0,
  );
}

export interface ToolRunResult {
  callId: string;
  name: string;
  status: ToolResultStatus;
  result: unknown;
  /** Present only when the tool returned the `{ text, images }` convention; never persisted. */
  images?: ToolImage[];
}
