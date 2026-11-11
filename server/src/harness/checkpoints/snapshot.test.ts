import { describe, expect, it } from 'vitest';
import { isRestorable, snapshotPreState } from './snapshot';
import type { McpGateway } from '../tools/types';

/**
 * The snapshot decides whether a checkpoint may claim undoability. Every test here is really a
 * test of the plan's safety rule: `restorable` must be backed by a read, never assumed.
 */

const tools = (...names: string[]): McpGateway['listTools'] => async () =>
    names.map((name) => ({ name, description: name, parameters: { type: 'object' } }));

function gateway(over: Partial<McpGateway> = {}): McpGateway {
    return {
        connected: true,
        studioLinked: true,
        server: { source: 'studio-builtin', path: 'C:/mcp.exe', version: '1' },
        studio: { id: 'place-1', name: 'Place' },
        toolCount: 2,
        lastError: null,
        listTools: tools('studio.script_read'),
        callTool: async () => 'old source',
        reconnect: async () => undefined,
        close: async () => undefined,
        ...over,
    };
}

describe('snapshotPreState', () => {
    it('captures a script write and plans the inverse as a write of the old source', async () => {
        const snapshot = await snapshotPreState(
            gateway({ callTool: async () => 'local Old = {}' }),
            'studio.write_script',
            { path: 'ServerScriptService/Main', source: 'local New = {}' },
        );
        expect(snapshot.entries).toEqual([
            { kind: 'script', path: 'ServerScriptService/Main', source: 'local Old = {}' },
        ]);
        expect(snapshot.inverse).toEqual([
            { tool: 'script_write', path: 'ServerScriptService/Main', source: 'local Old = {}' },
        ]);
        expect(snapshot.notes).toEqual([]);
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('reads the source out of the MCP content-array shape', async () => {
        // Studio answers `{ content: [{ type: 'text', text: '…' }] }`; missing this shape would
        // make every real restore non-restorable while the tests stayed green on bare strings.
        const snapshot = await snapshotPreState(
            gateway({ callTool: async () => ({ content: [{ type: 'text', text: 'local FromMcp = {}' }] }) }),
            'studio.edit_script',
            { path: 'A' },
        );
        expect(snapshot.entries[0]).toMatchObject({ source: 'local FromMcp = {}' });
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('expands multi_edit into one inverse per touched path', async () => {
        const snapshot = await snapshotPreState(
            gateway({ callTool: async () => 'old' }),
            'studio.multi_edit',
            { edits: [{ path: 'A' }, { path: 'B' }] },
        );
        expect(snapshot.inverse.map((step) => step.path)).toEqual(['A', 'B']);
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('treats a dedicated create tool with no readable old source as an insert, even with no read tool', async () => {
        // `studio.write_script` is a create tool by name: its inverse is a delete regardless of whether
        // the old source could be read, because there is no existing script to restore a source onto.
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools() }),
            'studio.write_script',
            { path: 'A', source: 'print("hi")' },
        );
        expect(snapshot.inverse).toEqual([{ tool: 'delete_instance', path: 'A' }]);
        expect(snapshot.notes).toEqual([]);
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('is NOT restorable when an edit (not a create) cannot read the old source', async () => {
        // `multi_edit` with a non-empty old_string is an EDIT of an existing script; if the read fails,
        // the inverse cannot be a delete (that would delete the user's script), so it stays a note.
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools() }),
            'studio.multi_edit',
            { edits: [{ path: 'A', old_string: 'x', new_string: 'y' }] },
        );
        expect(snapshot.inverse).toEqual([]);
        expect(snapshot.notes[0]).toContain('Không đọc được');
        expect(isRestorable(snapshot)).toBe(false);
    });

    it('is NOT restorable when the read throws', async () => {
        const snapshot = await snapshotPreState(
            gateway({ callTool: async () => { throw new Error('socket closed'); } }),
            'studio.edit_script',
            { path: 'A' },
        );
        expect(isRestorable(snapshot)).toBe(false);
        expect(snapshot.notes).toHaveLength(1);
    });

    it('treats a create with no readable old source as an insert, whose inverse is a delete', async () => {
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools(), callTool: async () => { throw new Error('not found'); } }),
            'studio.create_script',
            { path: 'NewScript', source: 'print("hi")' },
        );
        expect(snapshot.entries).toEqual([{ kind: 'inserted', path: 'NewScript' }]);
        expect(snapshot.inverse).toEqual([{ tool: 'delete_instance', path: 'NewScript' }]);
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('records an insert asset as a delete inverse', async () => {
        const snapshot = await snapshotPreState(gateway(), 'studio.insert_asset', { path: 'Workspace/Tree' });
        expect(snapshot.inverse).toEqual([{ tool: 'delete_instance', path: 'Workspace/Tree' }]);
    });

    it('captures instance properties when an inspect tool answers', async () => {
        const snapshot = await snapshotPreState(
            gateway({
                listTools: tools('studio.inspect_instance'),
                callTool: async () => ({ properties: { Transparency: 0, Anchored: true } }),
            }),
            'studio.set_property',
            { path: 'Workspace/Part' },
        );
        expect(snapshot.inverse).toEqual([
            { tool: 'set_properties', path: 'Workspace/Part', properties: { Transparency: 0, Anchored: true } },
        ]);
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('refuses to claim an inverse for arbitrary Luau with no target', async () => {
        const snapshot = await snapshotPreState(gateway(), 'studio.execute_luau', { code: 'print(1)' });
        expect(snapshot.inverse).toEqual([]);
        expect(isRestorable(snapshot)).toBe(false);
        expect(snapshot.notes[0]).toContain('execute_luau');
    });

    it('stays non-restorable when an edit target could not be read (partial read = no undoable claim)', async () => {
        // `multi_edit` with a non-empty old_string is an EDIT; if one target's read fails, that target is
        // a note, so the whole snapshot is non-restorable (a partial restore is forbidden by the plan).
        let call = 0;
        const snapshot = await snapshotPreState(
            gateway({
                callTool: async () => {
                    call += 1;
                    if (call === 2) throw new Error('gone');
                    return 'old';
                },
            }),
            'studio.multi_edit',
            { edits: [{ path: 'A', old_string: 'x', new_string: 'y' }, { path: 'B', old_string: 'x', new_string: 'y' }] },
        );
        expect(snapshot.inverse.map((step) => step.path)).toEqual(['A']);
        expect(snapshot.notes).toHaveLength(1);
        expect(isRestorable(snapshot)).toBe(false);
    });

    it('treats multi_edit with empty old_string as a create, so every target is an insert', async () => {
        // MEASURED: the real tool writes a new script when old_string is empty. Both targets become
        // inserts with delete inverses — fully restorable, never a partial note.
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools() }),
            'studio.multi_edit',
            { edits: [{ path: 'A', old_string: '', new_string: 'a' }, { path: 'B', old_string: '', new_string: 'b' }] },
        );
        expect(snapshot.inverse.map((step) => step.tool)).toEqual(['delete_instance', 'delete_instance']);
        expect(snapshot.notes).toEqual([]);
        expect(isRestorable(snapshot)).toBe(true);
    });
});
