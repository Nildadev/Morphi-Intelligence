/**
 * `@file` mention grammar, adapted from deepseek-harness `dsh-file-reference`:
 * an `@` at start/after whitespace triggers; email-like `a@b` does not.
 * Quoted mentions `@"path with spaces"` keep the quote open for directory descent.
 */
export interface ActiveMention {
  start: number;
  end: number;
  query: string;
  quoted: boolean;
}

export function activeAtToken(text: string, cursor: number): ActiveMention | undefined {
  const head = text.slice(0, cursor);
  // Quoted form: @"... (cursor inside quotes, closing quote optional for live completion)
  const quotedMatch = /@"([^"]*)"?$/.exec(head);
  if (quotedMatch && /@"[^"]*"?$/.test(head)) {
    const at = head.lastIndexOf('@');
    if (at < 0) return undefined;
    return { start: at, end: cursor, query: quotedMatch[1], quoted: true };
  }
  // Plain form: @token (no whitespace, no quote) preceded by start/whitespace.
  const plainMatch = /(?:^|\s)@([^\s"]*)$/.exec(head);
  if (!plainMatch) return undefined;
  const query = plainMatch[1];
  const end = cursor;
  const start = end - query.length - 1;
  return { start, end, query, quoted: false };
}

export function formatFileMention(candidatePath: string, keepOpen = false): string {
  const needsQuote = /[\s"]/.test(candidatePath);
  if (keepOpen && needsQuote) return `@"${candidatePath}`;
  if (keepOpen) return `@${candidatePath}`;
  if (needsQuote) return `@"${candidatePath}"`;
  return `@${candidatePath}`;
}
