import type { LlmMessage } from '../llm/types';

export const SUMMARY_FALLBACK_CHARS = 1024;

export type Complete = (prompt: string, model: string) => Promise<string>;

function label(message: LlmMessage): string {
  return message.role === 'tool' && message.toolCallId ? `tool(${message.toolCallId})` : message.role;
}

/** Plain role-prefixed transcript; the same rendering feeds the model and the fallback. */
export function renderTranscript(messages: LlmMessage[]): string {
  return messages
    .map((message) => {
      const calls = message.toolCalls?.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(', ');
      return `${label(message)}: ${message.content}${calls ? ` [calls: ${calls}]` : ''}`;
    })
    .join('\n');
}

function fallbackSummary(messages: LlmMessage[]): string {
  return renderTranscript(messages).slice(0, SUMMARY_FALLBACK_CHARS);
}

export async function summarizeMessages(messages: LlmMessage[], complete: Complete, model: string): Promise<string> {
  const prompt = [
    'Summarize the transcript excerpt below so the agent can keep working without seeing these turns again.',
    'Keep: the user goal, decisions taken, instance and script paths, findings that still matter, open questions, next steps.',
    `Write at most ${SUMMARY_FALLBACK_CHARS} characters of plain text.`,
    `Transcript:\n${renderTranscript(messages)}`,
  ].join('\n\n');

  try {
    const summary = (await complete(prompt, model)).trim();
    if (summary) return summary.slice(0, SUMMARY_FALLBACK_CHARS);
  } catch (error) {
    // Compaction must degrade, never break the turn that triggered it — but the provider failure
    // itself must still reach the log, or a broken summarizer looks like a working one.
    console.warn('[compaction] summarize failed, falling back to transcript truncation', error);
  }
  return fallbackSummary(messages);
}
