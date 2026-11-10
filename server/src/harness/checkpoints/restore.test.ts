import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { applyRestore, previewRestore } from './restore';
import { CheckpointStore } from './store';
import type { PreStateSnapshot } from './snapshot';
import type { McpGateway } from '../tools/types';

/**
 * Restore is a planned transaction with three promises that must hold:
 *  1. no drift ⇒ apply the inverse, verify by read-back, mark `restored`;
 *  2. drift ⇒ refuse, never overwrite the user's hand edit;
 *  3. a failed verification ⇒ `restore-failed`, never a false `restored`.
 */

function db() {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'P', 1, 1);
    db.prepare('INSERT INTO sessions (id, project_id, created_at, last_updated) VALUES (?, ?, ?, ?)').run('s1', 'p1', 1, 1);
    return db;
}

const snapshotOf = (over: Partial<PreStateSnapshot> = {}): PreStateSnapshot => ({
    entries: [{ kind: 'script', path: 'A', source: 'old' }],
    inverse: [{ tool: 'script_write', path: 'A', source: 'old' }],
    notes: [],
    ...over,
});

function record(store: CheckpointStore, snapshot: PreStateSnapshot | null, restorable: boolean) {
    return store.record({
        sessionId: 's1',
        label: 'test',
        manifest: {
            tool: 'studio.write_script',
            callId: 'c1',
            argsHash: 'h',
            targets: ['A'],
            outcome: 'ok',
            preState: snapshot,
            restorable,
            restoreReason: restorable ? 'ok' : 'no snapshot',
        },
    });
}

interface FakeMcpOptions {
    live?: string;
    /** What the live source becomes after a write; defaults to `written`. */
    afterWrite?: string;
    writeFails?: boolean;
    connected?: boolean;
    linked?: boolean;
}

function mcp(options: FakeMcpOptions = {}): McpGateway & { writes: Array<{ tool: string; args: unknown }> } {
    let live = options.live ?? 'old';
    const writes: Array<{ tool: string; args: unknown }> = [];
    return {
        connected: options.connected ?? true,
        studioLinked: options.linked ?? true,
        server: { source: 'studio-builtin', path: 'C:/mcp.exe', version: '1' },
        studio: { id: 'place', name: 'P' },
        toolCount: 3,
        lastError: null,
        writes,
        listTools: async () => ['studio.script_read', 'studio.write_script'].map((name) => ({
            name, description: name, parameters: { type: 'object' },
        })),
        callTool: async (name: string, args: unknown) => {
            if (name === 'studio.script_read') return live;
            writes.push({ tool: name, args });
            if (options.writeFails) throw new Error('write failed');
            live = options.afterWrite ?? (args as { source: string }).source;
            return { ok: true };
        },
        reconnect: async () => undefined,
        close: async () => undefined,
    };
}

describe('previewRestore', () => {
    it('returns the inverse plan and reports a clean workspace', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        const previewed = await previewRestore(mcp({ live: 'new' }), store, checkpoint.id);
        expect(previewed.ok).toBe(true);
        if (!previewed.ok) return;
        expect(previewed.preview.clean).toBe(true);
        expect(previewed.preview.steps).toEqual([
            { path: 'A', action: 'restore-script', summary: 'Khôi phục nguồn cũ của A' },
        ]);
    });

    it('refuses a checkpoint with no snapshot instead of inventing one', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, null, false);
        await expect(previewRestore(mcp(), store, checkpoint.id)).resolves.toEqual({ ok: false, reason: 'NOT_RESTORABLE' });
    });

    it('refuses when the checkpoint claims restorable but carries no inverse', async () => {
        // A row written by an older build, or a bug: the flag alone must never be trusted.
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf({ inverse: [] }), true);
        await expect(previewRestore(mcp(), store, checkpoint.id)).resolves.toEqual({ ok: false, reason: 'NOT_RESTORABLE' });
    });

    it('refuses when Studio is not linked', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        await expect(previewRestore(mcp({ linked: false }), store, checkpoint.id))
            .resolves.toEqual({ ok: false, reason: 'STUDIO_NOT_CONNECTED' });
    });

    it('refuses an already-restored checkpoint', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        store.setStatus(checkpoint.id, 'restored');
        await expect(previewRestore(mcp(), store, checkpoint.id)).resolves.toEqual({ ok: false, reason: 'ALREADY_RESTORED' });
    });

    it('404s an unknown checkpoint', async () => {
        const store = new CheckpointStore(db());
        await expect(previewRestore(mcp(), store, 'ckp_missing')).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    });

    it('notes that a target already equals its snapshot rather than claiming work to do', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        const previewed = await previewRestore(mcp({ live: 'old' }), store, checkpoint.id);
        expect(previewed.ok).toBe(true);
        if (!previewed.ok) return;
        expect(previewed.preview.notes.join(' ')).toContain('không có gì để khôi phục');
    });
});

describe('applyRestore', () => {
    it('writes the old source, verifies by read-back, and marks the checkpoint restored', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        const gateway = mcp({ live: 'new' });

        const restored = await applyRestore(gateway, store, checkpoint.id);

        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(restored.result).toMatchObject({ status: 'restored', applied: 1, failed: [] });
        expect(gateway.writes).toEqual([{ tool: 'studio.write_script', args: { path: 'A', source: 'old' } }]);
        expect(store.get(checkpoint.id)?.status).toBe('restored');
    });

    it('marks restore-failed when the write claims success but the read-back disagrees', async () => {
        // The core anti-lie rule: a tool answering OK is not proof the workspace changed.
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        const gateway = mcp({ live: 'new', afterWrite: 'still-new' });

        const restored = await applyRestore(gateway, store, checkpoint.id);

        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(restored.result.status).toBe('restore-failed');
        expect(restored.result.failed[0]?.reason).toContain('không khớp');
        expect(store.get(checkpoint.id)?.status).toBe('restore-failed');
    });

    it('marks restore-failed when the write tool throws', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        const gateway = mcp({ live: 'new', writeFails: true });

        const restored = await applyRestore(gateway, store, checkpoint.id);

        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(restored.result.status).toBe('restore-failed');
        expect(restored.result.applied).toBe(0);
    });

    it('does not attempt a write when the preview is not restorable', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, null, false);
        const gateway = mcp();

        const restored = await applyRestore(gateway, store, checkpoint.id);

        expect(restored).toEqual({ ok: false, reason: 'NOT_RESTORABLE' });
        expect(gateway.writes).toEqual([]);
    });

    it('leaves a checkpoint that is mid-restore alone', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, snapshotOf(), true);
        store.setStatus(checkpoint.id, 'restoring');
        const gateway = mcp();

        const restored = await applyRestore(gateway, store, checkpoint.id);

        expect(restored).toEqual({ ok: false, reason: 'IN_PROGRESS' });
        expect(gateway.writes).toEqual([]);
    });
});
