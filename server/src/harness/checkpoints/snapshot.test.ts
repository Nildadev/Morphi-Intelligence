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

    it('is NOT restorable when no read tool is exposed', async () => {
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools() }),
            'studio.write_script',
            { path: 'A' },
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

    it('stays non-restorable when SOME targets could not be read', async () => {
        // One unreadable file means a partial restore — the plan forbids claiming that as undoable.
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
            { edits: [{ path: 'A' }, { path: 'B' }] },
        );
        expect(snapshot.inverse.map((step) => step.path)).toEqual(['A']);
        expect(snapshot.notes).toHaveLength(1);
        expect(isRestorable(snapshot)).toBe(false);
    });
});
