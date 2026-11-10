/**
 * Auto-titles are plain text by rule: the model must never smuggle markdown (`**`, `##`,
 * backticks, quotes) into a session name — chrome (sidebar, breadcrumb) renders plain text.
 * The prompt says it; this sanitizer enforces it even when the model disobeys.
 */
export function cleanTitle(text: string): string {
  return text
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ');
}

export function fallbackTitle(text: string): string {
  const words = cleanTitle(text).split(' ').filter(Boolean).slice(0, 5);
  return words.join(' ') || 'New conversation';
}

export class TitleService {
  constructor(
    private complete: (prompt: string, model: string) => Promise<string>,
    private model: string,
  ) {}

  async generate(firstMessage: string): Promise<string> {
    try {
      const raw = await this.complete(
        `Generate a concise 4-5 word title for: ${firstMessage}\nPlain text only: no markdown, no asterisks, no hashtags, no backticks, no quotes.`,
        this.model,
      );
      const title = cleanTitle(raw);
      if (title && title.length <= 60) return title;
    } catch {
      // Provider failures must never block the chat turn; fall back to the heuristic.
    }
    return fallbackTitle(firstMessage);
  }
}
