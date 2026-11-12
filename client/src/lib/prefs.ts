import { useSyncExternalStore } from 'react';
import { applyUiLanguage } from '../i18n/vi';

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
  // The dictionary is module-level state that components read WHILE rendering, so it is swapped here,
  // in the event handler that changes the preference — never during render. The event below then
  // re-renders everything that reads it.
  applyUiLanguage(lang);
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

/**
 * Apply the stored language ONCE, at import time, before the first render.
 *
 * An effect would paint the default language first and there is no second render to correct it; doing
 * it in the component body instead is a side effect during render, which React forbids.
 */
applyUiLanguage(getUiLanguage());

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
