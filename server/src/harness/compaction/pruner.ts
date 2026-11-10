import type { LlmMessage } from '../llm/types';

const OMITTED_PATTERN = /^\[tool result omitted: \d+ chars\]$/;

export function omittedResultText(chars: number): string {
  return `[tool result omitted: ${chars} chars]`;
}

/**
 * A turn starts at a user message and runs to the next one; a steer message opens its own turn
 * because the projection creates one message per user/message event. The boundary is the index of
 * the oldest kept turn, so everything before it counts as old. With no more turns than the budget
 * nothing is old; a zero budget makes every message old.
 */
export function turnBoundaryIndex(messages: LlmMessage[], keepTurns: number): number {
  if (keepTurns <= 0) return messages.length;

  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') starts.push(index);
  });
  if (starts.length < keepTurns) return 0;
  return starts[starts.length - keepTurns];
}

/**
 * Request-time only: the event log keeps full tool results. Fresh objects for every message, so
 * the caller's context array and its messages stay untouched.
 */
export function pruneMessages(messages: LlmMessage[], keepTurns: number): LlmMessage[] {
  const boundary = turnBoundaryIndex(messages, keepTurns);

  return messages.map((message, index) => {
    const stale = index < boundary && message.role === 'tool' && !OMITTED_PATTERN.test(message.content);
    return stale ? { ...message, content: omittedResultText(message.content.length) } : { ...message };
  });
}
