import { useSyncExternalStore } from 'react';

/**
 * User preferences that live in `localStorage` (no server round-trip): the UI
 * language and the AI reply language. Each has a typed accessor pair, a change
 * event and a React hook so Settings, the transcript and ChatInterface stay in
 * sync.
 *
 * (The old streaming-text effect system was removed: streaming text renders as
 * accumulated deltas arrive, with no per-word animation to configure.)
 */

export type UiLanguage = 'vi' | 'en';
export type AiLanguage = 'auto' | 'vi' | 'en';

const UI_LANG_KEY = 'morphi.uiLang';
const UI_LANG_EVENT = 'morphi:ui-lang';

export function getUiLanguage(): UiLanguage {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_LANG_KEY) : null;
  return raw === 'en' || raw === 'vi' ? raw : 'vi';
}

export function setUiLanguage(lang: UiLanguage): void {
  localStorage.setItem(UI_LANG_KEY, lang);
  window.dispatchEvent(new Event(UI_LANG_EVENT));
}

function subscribeUiLanguage(callback: () => void): () => void {
  window.addEventListener(UI_LANG_EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(UI_LANG_EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(subscribeUiLanguage, getUiLanguage, () => 'vi' as UiLanguage);
}

const AI_LANG_KEY = 'morphi.aiLang';
const AI_LANG_EVENT = 'morphi:ai-lang';

export function getAiLanguage(): AiLanguage {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AI_LANG_KEY) : null;
  return raw === 'vi' || raw === 'en' || raw === 'auto' ? raw : 'auto';
}

export function setAiLanguage(lang: AiLanguage): void {
  localStorage.setItem(AI_LANG_KEY, lang);
  window.dispatchEvent(new Event(AI_LANG_EVENT));
}

function subscribeAiLanguage(callback: () => void): () => void {
  window.addEventListener(AI_LANG_EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(AI_LANG_EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

export function useAiLanguage(): AiLanguage {
  return useSyncExternalStore(subscribeAiLanguage, getAiLanguage, () => 'auto' as AiLanguage);
}
