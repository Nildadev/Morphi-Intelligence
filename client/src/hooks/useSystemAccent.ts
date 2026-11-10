import { useEffect, useRef } from 'react';
import { useTheme } from './useTheme';

interface AccentPayload {
    /** Normalised `#rrggbb` system accent from main.js, or `null` when unknown. */
    accent: string | null;
    dark: boolean;
}

function normalise(hex: string): string | null {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    return match ? `#${match[1].toLowerCase()}` : null;
}

/**
 * Tint the background surfaces with a faint haze of the system accent (which on Windows 11
 * follows the wallpaper), like Windows Settings. The app's own accent stays the brand green —
 * the system colour only lives in layered hazes (outer 8%, inner sidebar 6%, chat 3%), so the
 * personalisation reads as a tint of the room, never as a rebrand. The static brand tokens in
 * index.css stay as the web fallback; Electron pushes the live accent via `morphi:accent`.
 */
function applyAccent(payload: AccentPayload, dark: boolean): void {
    const root = document.documentElement;
    const rawHex = payload.accent ? normalise(payload.accent) : null;
    if (!rawHex) {
        for (const property of ['--bg-main', '--bg-sidebar', '--bg-outer', '--bg-card', '--bg-inset']) {
            root.style.removeProperty(property);
        }
        return;
    }

    const tint = (base: string, baseWeight: string) => `color-mix(in srgb, ${base} ${baseWeight}, ${rawHex})`;
    const surfaces: Record<string, string> = dark
        ? {
            '--bg-outer': tint('#171717', '92%'),
            '--bg-sidebar': tint('#171717', '94%'),
            '--bg-main': tint('#181818', '97%'),
            '--bg-card': tint('#212121', '97%'),
            '--bg-inset': tint('#2f2f2f', '97%'),
        }
        : {
            '--bg-outer': tint('#f9f9f9', '92%'),
            '--bg-sidebar': tint('#f9f9f9', '94%'),
            '--bg-main': tint('#ffffff', '97%'),
            '--bg-card': tint('#ffffff', '97%'),
            '--bg-inset': tint('#f3f3f3', '97%'),
        };
    for (const [property, value] of Object.entries(surfaces)) {
        root.style.setProperty(property, value);
    }
}

export function useSystemAccent(): void {
    const { theme } = useTheme();
    const last = useRef<AccentPayload | null>(null);

    useEffect(() => {
        const bridge = typeof window !== 'undefined' ? window.morphi : undefined;
        if (!bridge?.onAccent) return;
        const receive = (data: AccentPayload) => {
            last.current = data;
            applyAccent(data, document.documentElement.classList.contains('dark'));
        };
        // Pull once on mount (race-free vs the event push below), then stay live.
        void bridge.accent?.().then(receive).catch(() => undefined);
        return bridge.onAccent(receive);
    }, []);

    // A manual theme toggle changes the base the haze blends over — re-apply.
    useEffect(() => {
        if (last.current) applyAccent(last.current, theme === 'dark');
    }, [theme]);
}
