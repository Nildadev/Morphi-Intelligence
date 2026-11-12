import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

/**
 * The highlighter ships only the grammars a reply uses (`PrismLight` plus an explicit
 * `registerLanguage` list) to keep the bundle at 862KB instead of 1433KB. That change fails silently:
 * an unregistered grammar still renders, just without the theme's colours, so nothing else notices.
 *
 * With a `style` prop react-syntax-highlighter inlines the theme colours and drops the prism token
 * class names, so the assertion is on the colour a token actually got (`vscDarkPlus` keyword is
 * `#569CD6`) rather than on a `.keyword` class that is never emitted in this mode.
 */
const KEYWORD_COLOR = 'rgb(86, 156, 214)';
const STRING_COLOR = 'rgb(206, 145, 120)';
const FUNCTION_COLOR = 'rgb(220, 220, 170)';

/** Spans whose inline colour matches `color`; jsdom keeps `rgb()` spacing, so compare without spaces. */
function spansWithColor(container: HTMLElement, color: string): HTMLElement[] {
  const wanted = color.replace(/\s+/g, '').toLowerCase();
  return [...container.querySelectorAll<HTMLElement>('span.token')].filter(
    (span) => span.style.color.replace(/\s+/g, '').toLowerCase() === wanted,
  );
}

describe('Markdown code highlighting', () => {
  it('colours the languages a Roblox reply actually contains', () => {
    const cases: Array<[string, string, string, string]> = [
      // language, code, a word that must get that colour, colour
      ['lua', 'local part = Instance.new("Part")', 'local', KEYWORD_COLOR],
      ['luau', 'local x: number = 1\nif x then return end', 'if', KEYWORD_COLOR],
      ['typescript', 'const value: string = "hi";', 'const', KEYWORD_COLOR],
      ['javascript', 'function go() { return 1; }', 'function', KEYWORD_COLOR],
      ['json', '{"name": "Part"}', '"Part"', STRING_COLOR],
      ['python', 'def go():\n    return "x"', 'def', KEYWORD_COLOR],
      ['bash', 'npm run dev --silent', 'npm', FUNCTION_COLOR],
    ];

    for (const [language, code, word, color] of cases) {
      const { container, unmount } = render(<Markdown>{`\`\`\`${language}\n${code}\n\`\`\``}</Markdown>);
      const coloured = spansWithColor(container, color);
      expect(coloured.length, `${language}: no span got ${color}`).toBeGreaterThan(0);
      expect(
        coloured.some((span) => span.textContent === word),
        `${language}: "${word}" was not coloured — the grammar is probably unregistered`,
      ).toBe(true);
      unmount();
    }
  });

  it('keeps the label and the copy button for a fence it cannot colour', () => {
    const { container } = render(<Markdown>{'```brainfuck\n++++++\n```'}</Markdown>);
    // The label is the fence the model wrote, even with no grammar behind it...
    expect(screen.getAllByText('brainfuck').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/sao chép|copy/i)).toBeTruthy();
    // ...and the code is still visible (the highlighter splits it into spans, so read the whole block).
    expect(container.textContent).toContain('++++++');
  });
});
