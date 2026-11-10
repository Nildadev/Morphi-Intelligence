import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN } from '../compaction/estimator';
import { DEFAULT_CONTEXT_WINDOW } from '../compaction/service';
import {
  COMPLETION_RESERVE_MAX,
  effectiveWindow,
  fitToolsToWindow,
  toolOutputBudgetChars,
} from './window';

/**
 * The window a turn may fill is NOT the model's raw context: the provider needs room to write the
 * answer, and a tool result that eats the whole window leaves the model unable to reply at all.
 * These numbers are the contract the loop and the pipeline both read.
 */
describe('effectiveWindow', () => {
  it('keeps room for the completion instead of spending the whole context on the prompt', () => {
    // 200k context: the reserve is capped at 8k, so the prompt budget is 192k.
    expect(effectiveWindow(200_000)).toBe(200_000 - COMPLETION_RESERVE_MAX);
    expect(effectiveWindow(200_000)).toBeLessThan(200_000);
  });

  it('scales the reserve with small windows so an 8k model still gets to answer', () => {
    // 20% of 8k = 1.6k reserved for the reply.
    expect(effectiveWindow(8_000)).toBe(6_400);
  });

  it('falls back to the default window when the provider never declared one', () => {
    expect(effectiveWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW - COMPLETION_RESERVE_MAX);
    // A provider that reports 0 or a negative number is the same as reporting nothing.
    expect(effectiveWindow(0)).toBe(effectiveWindow(undefined));
  });

  it('never returns a window too small to hold a single exchange', () => {
    expect(effectiveWindow(1_000)).toBe(1_024);
    expect(effectiveWindow(1)).toBe(1_024);
  });
});

describe('toolOutputBudgetChars', () => {
  it('gives a small model a proportionally small tool budget', () => {
    // A quarter of 6 400 tokens, converted at the estimator's own ratio.
    expect(toolOutputBudgetChars(6_400)).toBe(Math.floor(6_400 * 0.25) * CHARS_PER_TOKEN);
  });

  it('never lets one tool result own more than the hard ceiling', () => {
    // A 1M-token model would otherwise allow 1M characters; the ceiling is what keeps a single
    // `search_game_tree` from swallowing the turn.
    expect(toolOutputBudgetChars(1_000_000)).toBe(50_000);
  });

  it('keeps a floor so a tiny window still shows something useful', () => {
    expect(toolOutputBudgetChars(100)).toBe(1_000);
  });
});

describe('fitToolsToWindow', () => {
  const schema = (name: string, chars: number) => ({
    name,
    description: 'x'.repeat(chars),
    parameters: { type: 'object' },
  });

  it('keeps the prefix that fits and drops the rest, so built-ins survive first', () => {
    // Prompt 100 tokens + 512 reserved for the reply leaves ~200 tokens of schema budget.
    const kept = fitToolsToWindow('p'.repeat(400), 100 + 512 + 200, [schema('a', 200), schema('b', 2_000)]);
    expect(kept.map((entry) => entry.name)).toEqual(['a']);
  });

  it('offers nothing rather than a prompt that cannot fit', () => {
    expect(fitToolsToWindow('p'.repeat(8_000), 1_024, [schema('a', 10)])).toEqual([]);
  });

  it('keeps every schema when the window is large', () => {
    const schemas = [schema('a', 200), schema('b', 200)];
    expect(fitToolsToWindow('p', 100_000, schemas)).toHaveLength(2);
  });
});
