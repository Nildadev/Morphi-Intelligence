import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useSystemAccent } from './useSystemAccent';
import type { WindowCommand } from '../lib/token';

function Probe() {
    useSystemAccent();
    return null;
}

let accentCallback: ((data: { accent: string | null; dark: boolean }) => void) | null = null;

function installBridge() {
    window.morphi = {
        getToken: vi.fn(async () => 'test-token'),
        credentials: {
            set: vi.fn(async () => ({ ok: true })),
            delete: vi.fn(async () => ({ ok: true })),
            status: vi.fn(async () => ({ persistent: true, providers: [] })),
        },
        window: { command: vi.fn(async (_action: WindowCommand) => ({ ok: true })) },
        theme: { set: vi.fn() },
        accent: vi.fn(async () => ({ accent: '#4cc2ff', dark: true })),
        onAccent: vi.fn((callback: (data: { accent: string | null; dark: boolean }) => void) => {
            accentCallback = callback;
            return () => { accentCallback = null; };
        }),
    };
}

const BG_PROPS = ['--bg-outer', '--bg-main', '--bg-sidebar', '--bg-card', '--bg-inset'];

beforeEach(() => {
    accentCallback = null;
    document.documentElement.classList.remove('dark');
    for (const property of [...BG_PROPS, '--accent', '--brand-text', '--selection-bg']) {
        document.documentElement.style.removeProperty(property);
    }
});

afterEach(() => {
    cleanup();
    delete window.morphi;
    document.documentElement.classList.remove('dark');
    for (const property of [...BG_PROPS, '--accent', '--brand-text', '--selection-bg']) {
        document.documentElement.style.removeProperty(property);
    }
});

describe('useSystemAccent', () => {
    it('hazes the background surfaces with a faint share of the system accent', () => {
        installBridge();
        render(<Probe />);

        expect(accentCallback).not.toBeNull();
        accentCallback?.({ accent: '#4cc2ff', dark: true });

        const root = document.documentElement.style;
        for (const property of BG_PROPS) {
            const value = root.getPropertyValue(property);
            expect(value).toContain('#4cc2ff');
            expect(value).toContain('color-mix');
        }
        // Three layers: outer 8%, inner sidebar 6%, chat 3%.
        expect(root.getPropertyValue('--bg-outer')).toContain('92%');
        expect(root.getPropertyValue('--bg-sidebar')).toContain('94%');
        expect(root.getPropertyValue('--bg-main')).toContain('97%');
        expect(root.getPropertyValue('--bg-card')).toContain('97%');
        // The brand accent itself is never touched — the logo stays the app's green.
        expect(root.getPropertyValue('--accent')).toBe('');
        expect(root.getPropertyValue('--brand-text')).toBe('');
    });

    it('removes the haze when the accent becomes unknown', () => {
        installBridge();
        render(<Probe />);

        accentCallback?.({ accent: '#4cc2ff', dark: false });
        expect(document.documentElement.style.getPropertyValue('--bg-main')).toContain('#4cc2ff');

        accentCallback?.({ accent: null, dark: false });
        for (const property of BG_PROPS) {
            expect(document.documentElement.style.getPropertyValue(property)).toBe('');
        }
    });

    it('is a no-op outside Electron (no bridge, no overrides)', () => {
        delete window.morphi;
        render(<Probe />);

        for (const property of [...BG_PROPS, '--accent']) {
            expect(document.documentElement.style.getPropertyValue(property)).toBe('');
        }
    });
});
