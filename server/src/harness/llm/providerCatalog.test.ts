import { describe, expect, it } from 'vitest';
import { CATALOG_AUTHORITY, PROVIDER_CATALOG } from './providerCatalog';

/**
 * The bundled snapshot is the only source of context windows, tool support and effort levels for
 * the gateways whose own /models listing carries no metadata, so it has to stay honest:
 * text-output only, unique ids, effort values the composer actually understands, ordered
 * least-first for the slider.
 */
const PROVIDERS = Object.keys(PROVIDER_CATALOG);

describe('PROVIDER_CATALOG', () => {
  it('covers every catalog-backed provider with unique ids', () => {
    // Every provider whose /models listing lacks context or effort facts (the models.dev
    // snapshot fills them), plus the two id-only gateways and the hand-written DeepSeek bridge.
    expect(PROVIDERS).toEqual(expect.arrayContaining([
      'nvidia', 'kilo', 'deepseek-chat', 'openai', 'anthropic', 'deepseek', 'groq', 'mistral',
      'xai', 'cerebras', 'together', 'fireworks', 'perplexity', 'deepinfra',
    ]));
    for (const provider of PROVIDERS) {
      const cards = PROVIDER_CATALOG[provider];
      expect(cards.length, provider).toBeGreaterThan(0);
      expect(new Set(cards.map((card) => card.id)).size, provider).toBe(cards.length);
      // A raw id is never shown when a card exists.
      for (const card of cards) {
        expect(card.id, provider).not.toEqual('');
        expect(card.name, provider).not.toEqual('');
        expect(card.tools, `${provider}/${card.id}`).toBeTypeOf('boolean');
      }
    }
  });

  it('declares effort levels the app understands, least first', () => {
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const provider of PROVIDERS) {
      for (const card of PROVIDER_CATALOG[provider]) {
        if (card.efforts === undefined) continue;
        expect(card.efforts.length, `${provider}/${card.id}`).toBeGreaterThan(0);
        const ranks = card.efforts.map((level) => {
          const rank = order.indexOf(level);
          expect(rank, `${provider}/${card.id}: ${level}`).toBeGreaterThanOrEqual(0);
          return rank;
        });
        expect([...ranks].sort((a, b) => a - b), `${provider}/${card.id}`).toEqual(ranks);
      }
    }
  });

  it('marks which catalogs are the lineup rather than an enrichment', () => {
    // The gateways whose wire listing carries ids and `owned_by` only, and the bridge that
    // serves a fixed pair: no card means "not a chat model", so those three are authoritative.
    expect([...CATALOG_AUTHORITY].sort()).toEqual(['deepseek-chat', 'kilo', 'nvidia']);
    // Everyone else keeps its wire lineup (even ids the snapshot has never heard of), so an
    // enriching provider is never trapped behind a stale snapshot.
    expect(CATALOG_AUTHORITY.has('openai')).toBe(false);
    expect(CATALOG_AUTHORITY.has('deepseek')).toBe(false);
  });

  it('knows the NIM models a NIM key actually serves, metadata included', () => {
    const cards = new Map(PROVIDER_CATALOG.nvidia.map((card) => [card.id, card]));
    const flash = cards.get('deepseek-ai/deepseek-v4.1-flash');
    expect(flash).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      context: 1_000_000,
      output: 384_000,
      tools: true,
      images: true,
      efforts: ['low', 'high', 'max'],
    });
    // A reasoning knob exists only where the catalogue declares one.
    expect(cards.get('mistralai/mistral-7b-instruct-v0.3')?.efforts).toBeUndefined();
    // Non-chat families are absent: NIM's own listing has them (embed/parse/guard), the catalogue
    // is the filter.
    for (const id of ['nvidia/embed-qa-4', 'nvidia/nemotron-parse', 'nvidia/nvclip', 'nvidia/vila']) {
      expect(cards.has(id), id).toBe(false);
    }
  });

  it('fills the context window an OpenAI-style listing never sends', () => {
    // OpenAI/anthropic listings answer with ids alone: no context length, no tool declaration.
    // These cards are what the picker, the context ring and the effort selector display instead.
    const openai = new Map(PROVIDER_CATALOG.openai.map((card) => [card.id, card]));
    expect(openai.get('gpt-4o-mini')).toMatchObject({
      name: 'GPT-4o mini',
      context: 128_000,
      tools: true,
      images: true,
    });
    expect(openai.get('gpt-5.1')?.efforts).toEqual(['low', 'medium', 'high']);
    // The official DeepSeek API lists ids with no context either: 1M windows come from the cards.
    const deepseek = new Map(PROVIDER_CATALOG.deepseek.map((card) => [card.id, card]));
    expect(deepseek.get('deepseek-v4-pro')).toMatchObject({
      name: 'DeepSeek V4 Pro',
      context: 1_048_576,
      efforts: ['low', 'high', 'max'],
    });
  });

  it('describes the local DeepSeek bridge as tool-less and thinking-toggle only', () => {
    const cards = PROVIDER_CATALOG['deepseek-chat'];
    expect(cards.map((card) => card.id)).toEqual(['deepseek-chat', 'deepseek-expert']);
    for (const card of cards) {
      // The bridge ignores tool definitions (no tool_call is ever emitted), so the loop sends
      // none instead of pretending Studio tools are reachable through it.
      expect(card.tools, card.id).toBe(false);
      // DeepThink is a boolean `thinking` toggle, not an effort ladder: no declared levels means
      // the selector is not offered, and any picked level only turns DeepThink on.
      expect(card.efforts, card.id).toBeUndefined();
      expect(card.context, card.id).toBeGreaterThan(0);
      expect(card.images, card.id).toBe(false);
    }
  });
});
