import { useCallback, useEffect, useSyncExternalStore } from 'react';

export const THEME_KEY = 'morphi.theme';

export type Theme = 'light' | 'dark';

function readStoredTheme(): Theme | null {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch {
        // Private-mode storage denial must not stop the toggle from working.
    }
    return null;
}

function osPrefersDark(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Stored value wins, then the OS preference, then light. */
const initialTheme = (): Theme => readStoredTheme() ?? (osPrefersDark() ? 'dark' : 'light');

// Một class `.dark` trên <html> là sự thật duy nhất, nên theme cũng phải sống ở một chỗ duy nhất.
// `useState` trong từng component sẽ cho hai consumer (header + hàng Settings) hai giá trị khác nhau
// cùng mô tả một class, và cú bấm đầu tiên sau đó trông như không có phản hồi.
let current: Theme = initialTheme();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function getSnapshot(): Theme {
    return current;
}

function write(theme: Theme): void {
    current = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    // Keep the pre-paint attribute in sync: `index.html` reads `data-theme` before any module
    // loads so the splash screen matches the theme instead of flashing dark on a light UI.
    // Without this line the first toggle would persist the new theme but the next reload's
    // splash would still use the value written at load time.
    document.documentElement.setAttribute('data-theme', theme);
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch {
        // Persisting is best-effort; the class above already toggled.
    }
    for (const listener of listeners) listener();
}

export function useTheme() {
    const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    useEffect(() => {
        document.documentElement.classList.toggle('dark', current === 'dark');
        // The inline script in index.html resolves this before first paint; re-assert it here
        // so the DOM always reflects the store even if that script ran with a stale value.
        document.documentElement.setAttribute('data-theme', current);
    });

    // Keep the Electron titlebar overlay on the same theme as the strip (no-op outside Electron).
    useEffect(() => {
        try {
            window.morphi?.theme?.set?.(theme);
        } catch {
            // The overlay sync is cosmetic; a failed send must never break the toggle.
        }
    }, [theme]);

    const toggle = useCallback(() => {
        write(current === 'dark' ? 'light' : 'dark');
    }, []);

    return { theme, toggle };
}
