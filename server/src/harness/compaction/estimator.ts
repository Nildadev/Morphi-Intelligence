import type { LlmMessage } from '../llm/types';

export const CHARS_PER_TOKEN = 4;

function messageChars(message: LlmMessage): number {
  const calls = message.toolCalls ? JSON.stringify(message.toolCalls).length : 0;
  return (message.content?.length ?? 0) + (message.reasoning?.length ?? 0) + calls;
}

/**
 * chars / 4, deliberately crude: a threshold signal, not a billing figure. The caller prefers
 * real provider usage whenever an adapter reports it and only uses this to pick thresholds.
 */
export function estimateTokens(messages: LlmMessage[]): number {
  const chars = messages.reduce((total, message) => total + messageChars(message), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
