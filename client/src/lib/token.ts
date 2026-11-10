/** Window-level commands the titlebar can issue (handled in main.js, no-ops outside Electron). */
export type WindowCommand =
  | 'close' | 'quit' | 'reload' | 'devtools' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'fullscreen' | 'about';

declare global {
  interface Window {
    morphi?: {
      getToken(): Promise<string>;
      credentials: {
        set(providerId: string, apiKey: string): Promise<{ ok: boolean; persistent?: boolean }>;
        delete(providerId: string): Promise<{ ok: boolean }>;
        status(): Promise<{ persistent: boolean; providers: { providerId: string; configured: boolean }[] }>;
      };
      window: {
        command(action: WindowCommand): Promise<{ ok: boolean }>;
      };
      theme: {
        set(theme: 'light' | 'dark'): void;
      };
      accent(): Promise<{ accent: string | null; dark: boolean }>;
      onAccent(callback: (data: { accent: string | null; dark: boolean }) => void): () => void;
    };
  }
}

let cached: string | undefined;

/**
 * Resolve the API token from the Electron preload bridge.
 *
 * The token is kept in memory only. It is never written to localStorage or
 * any other persistent client storage. `dev-token` is a Vite-dev fallback that
 * matches the server's `loadConfig` default; production builds fail loudly
 * instead of sending a placeholder token.
 */
export async function getToken(): Promise<string> {
  if (cached) return cached;
  if (typeof window !== 'undefined' && window.morphi) {
    cached = await window.morphi.getToken();
    return cached;
  }
  if (!import.meta.env.DEV) throw new Error('MORPHI_TOKEN_UNAVAILABLE');
  return 'dev-token';
}
