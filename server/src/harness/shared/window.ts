import { CHARS_PER_TOKEN } from '../compaction/estimator';
import type { ToolSchema } from '../llm/types';
import { DEFAULT_CONTEXT_WINDOW } from '../compaction/service';

/**
 * Task 31C follow-up — the context window is a PER-MODEL number, and two things depend on it:
 *
 * 1. how much history a turn may carry (`effectiveWindow`), and
 * 2. how much a single tool result may return (`toolOutputBudgetChars`).
 *
 * Before this, the loop spent the model's whole context on the prompt and the pipeline capped every
 * tool at a flat 50 000 characters. On an 8k model that meant a `search_game_tree` result (22 803
 * characters live) could not fit at all, and the turn died with CONTEXT_OVERFLOW after the tool had
 * already run. Both numbers now derive from what the provider actually declared.
 */

/** Room kept for the model's own answer. Capped so a 1M-token model does not reserve 200k. */
export const COMPLETION_RESERVE_MAX = 8_192;
export const COMPLETION_RESERVE_MIN = 1_024;
export const COMPLETION_RESERVE_RATIO = 0.2;

/** Smallest prompt budget worth starting a turn with. */
const MIN_WINDOW = 1_024;

/** Share of the window one tool result may take, and its hard floor/ceiling in characters. */
const TOOL_BUDGET_RATIO = 0.25;
const TOOL_BUDGET_MIN_CHARS = 1_000;
const TOOL_BUDGET_MAX_CHARS = 50_000;

/**
 * What the prompt plus history may fill. `undefined` means the provider never declared a context —
 * the same as declaring zero — and falls back to the app default instead of guessing small.
 */
export function effectiveWindow(context?: number): number {
  const raw = typeof context === 'number' && Number.isFinite(context) && context > 0
    ? context
    : DEFAULT_CONTEXT_WINDOW;
  const reserve = Math.min(
    COMPLETION_RESERVE_MAX,
    Math.max(COMPLETION_RESERVE_MIN, Math.round(raw * COMPLETION_RESERVE_RATIO)),
  );
  return Math.max(MIN_WINDOW, raw - reserve);
}

/**
 * Characters a single tool result may return in this window. A quarter of the budget, so a turn can
 * afford a few tool calls before the transcript itself becomes the problem.
 */
export function toolOutputBudgetChars(window: number): number {
  const tokens = Math.max(1, Math.floor(window * TOOL_BUDGET_RATIO));
  const chars = tokens * CHARS_PER_TOKEN;
  return Math.min(TOOL_BUDGET_MAX_CHARS, Math.max(TOOL_BUDGET_MIN_CHARS, chars));
}

/** Room the answer itself needs, scaled down for a small window so a tool can still fit. */
const replyReserve = (window: number): number => Math.min(512, Math.floor(window / 4));

/**
 * The tool schemas that still fit after the prompt. A 35-tool Studio surface costs ~4k tokens of
 * schema on its own, so an 8k model cannot be offered all of it and still answer. The list is cut
 * from the END, which keeps built-ins first (registry order), and an empty result is honest: the
 * model simply gets no tools instead of a prompt that cannot fit.
 */
export function fitToolsToWindow(prompt: string, window: number, schemas: ToolSchema[]): ToolSchema[] {
  const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  let budget = window - promptTokens - replyReserve(window);
  if (budget <= 0) return [];
  const kept: ToolSchema[] = [];
  for (const schema of schemas) {
    const cost = Math.ceil(JSON.stringify(schema).length / CHARS_PER_TOKEN);
    if (cost > budget) break;
    kept.push(schema);
    budget -= cost;
  }
  return kept;
}
