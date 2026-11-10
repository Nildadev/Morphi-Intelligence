import type { SpillRef } from './store';

/**
 * Shared spill notice formatting, adapted from deepseek `dsh-spill-policy` (`./notice`):
 * one convention both the pipeline preview and any future consumer must agree on.
 */

export function formatSpillNotice(omittedChars: number, ref: SpillRef, originalChars: number): string {
  return `(Omitted ${omittedChars} of ${originalChars} chars. Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint})`;
}

export function hasSpillNotice(text: string): boolean {
  return text.includes('Full formatted result stored at:');
}

/** Head/tail ordered retention: keep both ends, omit the middle, never reorder. */
export function retainHeadTail(text: string, limit: number, notice: string): string {
  if (text.length <= limit) return text;
  const budget = Math.max(0, limit - notice.length - 12);
  if (budget <= 0) return text; // A notice that cannot fit disables replacement for that call.
  const headChars = Math.ceil(budget / 2);
  const tailChars = budget - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
  const omitted = text.length - head.length - tail.length;
  const middle = '\n\n... [omitted middle] ...\n\n';
  return `${head}${middle}${tail}\n\n${notice}`;
}
