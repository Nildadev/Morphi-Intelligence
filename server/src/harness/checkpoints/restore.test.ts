import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { applyRestore, previewRestore, restoreTurn } from './restore';
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

describe('restoreTurn - the Undo button on the script summary', () => {
    const recordTurn = (
        store: CheckpointStore,
        callId: string,
        path: string,
        source: string,
        restorable = true,
    ) => store.record({
        sessionId: 's1',
        label: `edit ${path}`,
        manifest: {
            tool: 'studio.write_script',
            callId,
            argsHash: 'h',
            targets: [path],
            outcome: 'ok',
            preState: restorable
                ? { entries: [{ kind: 'script', path, source }], inverse: [{ tool: 'script_write', path, source }], notes: [] }
                : null,
            restorable,
            restoreReason: restorable ? 'ok' : 'Chưa chụp được snapshot trước khi sửa.',
        },
    });

    it('restores every restorable checkpoint of the turn in one call', async () => {
        const store = new CheckpointStore(db());
        recordTurn(store, 'call_a', 'A', 'old-a');
        recordTurn(store, 'call_b', 'B', 'old-b');
        const gateway = mcp({ live: 'new' });
        // Two scripts, so the fake read/write must track each path independently.
        const byPath = new Map([['A', 'new'], ['B', 'new']]);
        gateway.listTools = async () => ['studio.script_read', 'studio.write_script'].map((name) => ({
            name, description: name, parameters: { type: 'object' },
        }));
        gateway.callTool = async (name: string, args: unknown) => {
            const record = args as { path: string; source?: string };
            if (name === 'studio.script_read') return byPath.get(record.path) ?? null;
            gateway.writes.push({ tool: name, args });
            byPath.set(record.path, record.source ?? '');
            return { ok: true };
        };

        const result = await restoreTurn(gateway, store, 's1', ['call_a', 'call_b']);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result.status).toBe('restored');
        expect(result.result.restored).toHaveLength(2);
        expect(byPath.get('A')).toBe('old-a');
        expect(byPath.get('B')).toBe('old-b');
    });

    it('refuses the WHOLE turn when one target drifted, writing nothing', async () => {
        // Half-restoring a turn leaves the workspace matching neither the old nor the new code.
        // Drift here is a target that cannot be read back (`null`), which the engine treats as an
        // unverifiable restore and therefore refuses before writing anything.
        const store = new CheckpointStore(db());
        recordTurn(store, 'call_a', 'A', 'old-a');
        recordTurn(store, 'call_b', 'B', 'old-b');
        const gateway = mcp({ live: 'new' });
        // `A` reads back fine; `B` is gone from the place, so its preview cannot be trusted.
        gateway.listTools = async () => ['studio.script_read', 'studio.write_script'].map((name) => ({
            name, description: name, parameters: { type: 'object' },
        }));
        gateway.callTool = async (name: string, args: unknown) => {
            const record = args as { path: string };
            if (name === 'studio.script_read') return record.path === 'B' ? null : 'new';
            gateway.writes.push({ tool: name, args });
            return { ok: true };
        };

        const result = await restoreTurn(gateway, store, 's1', ['call_a', 'call_b']);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result.status).toBe('refused');
        expect(result.result.restored).toEqual([]);
        expect(gateway.writes).toEqual([]);
    });

    it('reports non-restorable checkpoints separately instead of implying full success', async () => {
        const store = new CheckpointStore(db());
        recordTurn(store, 'call_a', 'A', 'old-a');
        recordTurn(store, 'call_b', 'B', '', false);
        const gateway = mcp({ live: 'new' });

        const result = await restoreTurn(gateway, store, 's1', ['call_a', 'call_b']);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result.restored).toHaveLength(1);
        expect(result.result.notRestorable).toHaveLength(1);
        expect(result.result.notRestorable[0]?.reason).toContain('snapshot');
    });

    it('says NOTHING_TO_RESTORE when the call ids match no checkpoint', async () => {
        const store = new CheckpointStore(db());
        await expect(restoreTurn(mcp(), store, 's1', ['nope']))
            .resolves.toEqual({ ok: false, reason: 'NOTHING_TO_RESTORE' });
    });

    it('refuses without a linked Studio, before any write', async () => {
        const store = new CheckpointStore(db());
        recordTurn(store, 'call_a', 'A', 'old-a');
        const gateway = mcp({ linked: false });
        await expect(restoreTurn(gateway, store, 's1', ['call_a']))
            .resolves.toEqual({ ok: false, reason: 'STUDIO_NOT_CONNECTED' });
        expect(gateway.writes).toEqual([]);
    });

    /**
     * Phase 5 regression, caught LIVE: drift compared the live source with the PRE-state only, and
     * after a successful mutation the live source legitimately differs from it — so a hand edit made
     * AFTER the turn (script at `local V = 99` while the turn wrote `local V = 2`) previewed as
     * `clean: true` and the undo silently overwrote it. The checkpoint now also stores what the turn
     * WROTE (`postState`), and drift diffs against that: live == post ⇒ invert; live == pre ⇒ no-op;
     * neither ⇒ refuse.
     */
    it('refuses a hand edit made after the turn instead of silently overwriting it', async () => {
        const store = new CheckpointStore(db());
        store.record({
            sessionId: 's1',
            label: 'edit A',
            manifest: {
                tool: 'studio.write_script',
                callId: 'call_a',
                argsHash: 'h',
                targets: ['A'],
                outcome: 'ok',
                preState: { entries: [{ kind: 'script', path: 'A', source: 'old' }], inverse: [{ tool: 'script_write', path: 'A', source: 'old' }], notes: [] },
                postState: { entries: [{ kind: 'script', path: 'A', source: 'new' }], notes: [] },
                restorable: true,
                restoreReason: 'ok',
            },
        });
        // The live source is neither the turn's output (`new`) nor the pre-state (`old`): someone
        // edited it by hand after the turn.
        const gateway = mcp({ live: 'hand edit' });

        const result = await restoreTurn(gateway, store, 's1', ['call_a']);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result.status).toBe('refused');
        expect(result.result.drift[0]).toContain('sửa tay');
        expect(gateway.writes).toEqual([]);
    });

    it('restores when the live source still matches what the turn wrote', async () => {
        const store = new CheckpointStore(db());
        store.record({
            sessionId: 's1',
            label: 'edit A',
            manifest: {
                tool: 'studio.write_script',
                callId: 'call_a',
                argsHash: 'h',
                targets: ['A'],
                outcome: 'ok',
                preState: { entries: [{ kind: 'script', path: 'A', source: 'old' }], inverse: [{ tool: 'script_write', path: 'A', source: 'old' }], notes: [] },
                postState: { entries: [{ kind: 'script', path: 'A', source: 'new' }], notes: [] },
                restorable: true,
                restoreReason: 'ok',
            },
        });
        const gateway = mcp({ live: 'new' });

        const result = await restoreTurn(gateway, store, 's1', ['call_a']);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result.status).toBe('restored');
        expect(gateway.writes).toEqual([{ tool: 'studio.write_script', args: { path: 'A', source: 'old' } }]);
    });

    it('keeps the pre-state behaviour for checkpoints recorded before post-state capture', async () => {
        // History must stay restorable: an old manifest has no `postState` at all, so drift falls
        // back to comparing with the pre-state (the old, weaker rule) instead of refusing forever.
        const store = new CheckpointStore(db());
        recordTurn(store, 'call_a', 'A', 'old-a');
        const gateway = mcp({ live: 'new' });

        const result = await restoreTurn(gateway, store, 's1', ['call_a']);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result.status).toBe('restored');
        expect(gateway.writes).toEqual([{ tool: 'studio.write_script', args: { path: 'A', source: 'old-a' } }]);
    });
});

describe('restore of a DELETED instance', () => {
    const tree = {
        path: 'Workspace.Model',
        className: 'Model',
        name: 'Model',
        properties: {},
        children: [{
            path: 'Workspace.Model.Part',
            className: 'Part',
            name: 'Part',
            properties: { Material: 'Enum.Material.Plastic' },
            children: [],
        }],
    };
    const deletedSnapshot = (): PreStateSnapshot => ({
        entries: [{ kind: 'deleted', path: 'Workspace.Model', tree }],
        inverse: [{ tool: 'recreate_instance', path: 'Workspace.Model', tree }],
        notes: [],
    });

    /** Luau answers: `missing`/`exists` for the existence probe, a JSON report otherwise. */
    function luauGateway(options: { exists?: boolean; probeFails?: boolean } = {}) {
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        // The probe must answer for the world AFTER the call under test, so a create flips it.
        let exists = options.exists ?? false;
        const gateway: McpGateway & { calls: typeof calls } = {
            connected: true,
            studioLinked: true,
            server: { source: 'studio-builtin', path: 'C:/mcp.exe', version: '1' },
            studio: { id: 'place', name: 'P' },
            toolCount: 1,
            lastError: null,
            calls,
            listTools: async () => [{ name: 'execute_luau', description: 'luau', parameters: { type: 'object' } }],
            callTool: async (name, args) => {
                const record = (args ?? {}) as Record<string, unknown>;
                calls.push({ tool: name, args: record });
                const code = String(record.code ?? '');
                if (code.includes('"exists"')) {
                    if (options.probeFails === true) return 'error: cannot probe';
                    return exists ? 'exists' : 'missing';
                }
                if (code.includes('Instance.new')) exists = true;
                return JSON.stringify({ ok: true, failed: [] });
            },
            reconnect: async () => undefined,
            close: async () => undefined,
        };
        return gateway;
    }

    it('previews the recreate when the instance really is gone', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, deletedSnapshot(), true);
        const preview = await previewRestore(luauGateway(), store, checkpoint.id);
        expect(preview.ok).toBe(true);
        if (!preview.ok) return;
        expect(preview.preview.clean).toBe(true);
        expect(preview.preview.steps[0]).toMatchObject({ action: 'recreate-deleted', path: 'Workspace.Model' });
    });

    it('never recreates over something that occupies the path now', async () => {
        // Overwriting live work is the one thing the plan forbids, so the undo stands down.
        const store = new CheckpointStore(db());
        const checkpoint = record(store, deletedSnapshot(), true);
        const preview = await previewRestore(luauGateway({ exists: true }), store, checkpoint.id);
        expect(preview.ok).toBe(true);
        if (!preview.ok) return;
        expect(preview.preview.notes.join(' ')).toContain('đang tồn tại');
    });

    it('treats a failed existence probe as drift, never as "gone"', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, deletedSnapshot(), true);
        const preview = await previewRestore(luauGateway({ probeFails: true }), store, checkpoint.id);
        expect(preview.ok).toBe(true);
        if (!preview.ok) return;
        expect(preview.preview.clean).toBe(false);
    });

    it('recreates the subtree and marks the checkpoint restored', async () => {
        const store = new CheckpointStore(db());
        const checkpoint = record(store, deletedSnapshot(), true);
        const gateway = luauGateway({ exists: false });
        const restored = await applyRestore(gateway, store, checkpoint.id);
        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(restored.result).toMatchObject({ status: 'restored', applied: 1 });
        const created = gateway.calls
            .map((call) => String(call.args.code ?? ''))
            .filter((code) => code.includes('Instance.new'));
        expect(created).toHaveLength(2);
        expect(created[0]).toContain('pcall(Instance.new, "Model")');
        expect(created[1]).toContain('pcall(Instance.new, "Part")');
        // Parent first: the child can only be parented once its parent exists.
        expect(created[1]).toContain('{"Workspace", "Model"}');
        expect(store.get(checkpoint.id)?.status).toBe('restored');
    });
});
