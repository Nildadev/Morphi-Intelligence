import { describe, expect, it, vi } from 'vitest';
import { createShutdown, type ShutdownDeps } from './shutdown';

/**
 * A quit is the one code path nobody exercises by hand: it runs with the window already gone, so a
 * mistake here is invisible until a user reports an orphaned Studio process or a locked database.
 */
function deps(overrides: Partial<ShutdownDeps> = {}): {
    calls: string[];
    deps: ShutdownDeps;
} {
    const calls: string[] = [];
    const base: ShutdownDeps = {
        abortTurns: () => { calls.push('abortTurns'); },
        closeMcp: async () => { calls.push('closeMcp'); },
        disposeHarness: async () => { calls.push('disposeHarness'); },
        closeServer: (onClosed) => { calls.push('closeServer'); onClosed(); },
        closeDb: () => { calls.push('closeDb'); },
        exit: (code) => { calls.push(`exit:${code}`); },
    };
    return { calls, deps: { ...base, ...overrides } };
}

describe('createShutdown', () => {
    it('aborts turns, closes the child, disposes plugins, then closes the server and the database', async () => {
        const { calls, deps: d } = deps();
        await createShutdown(d)();
        expect(calls).toEqual(['abortTurns', 'closeMcp', 'disposeHarness', 'closeServer', 'closeDb', 'exit:0']);
    });

    it('keeps going when one step throws: a broken dispose must not strand the database', async () => {
        const log = vi.fn();
        const { calls, deps: d } = deps({
            disposeHarness: async () => { throw new Error('plugin blew up'); },
            log,
        });
        await createShutdown(d)();
        expect(calls).toEqual(['abortTurns', 'closeMcp', 'closeServer', 'closeDb', 'exit:0']);
        expect(log).toHaveBeenCalledWith('shutdown: disposing plugins failed: plugin blew up');
    });

    it('closes the database when the server close throws', async () => {
        const { calls, deps: d } = deps({
            closeServer: () => { throw new Error('not listening'); },
        });
        await createShutdown(d)();
        expect(calls).toEqual(['abortTurns', 'closeMcp', 'disposeHarness', 'closeDb', 'exit:0']);
    });

    it('is idempotent: a second signal runs nothing again', async () => {
        const { calls, deps: d } = deps();
        const shutdown = createShutdown(d);
        await Promise.all([shutdown(), shutdown()]);
        await shutdown();
        expect(calls.filter((call) => call === 'closeDb')).toHaveLength(1);
        expect(calls.filter((call) => call === 'exit:0')).toHaveLength(1);
    });

    it('closes the database once even when a stuck response never lets the server close', async () => {
        vi.useFakeTimers();
        try {
            const { calls, deps: d } = deps({
                // A live SSE response keeps `server.close()` from ever calling back.
                closeServer: () => { /* never calls onClosed */ },
                timeoutMs: 50,
            });
            const shutdown = createShutdown(d);
            void shutdown();
            await vi.advanceTimersByTimeAsync(60);
            expect(calls).toEqual(['abortTurns', 'closeMcp', 'disposeHarness', 'closeDb', 'exit:0']);
        } finally {
            vi.useRealTimers();
        }
    });
});
