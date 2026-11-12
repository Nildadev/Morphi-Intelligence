import { describe, expect, it } from 'vitest';
import { isRestorable, pathFromLuau, snapshotPostState, snapshotPreState, type PreStateSnapshot } from './snapshot';
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

describe('snapshotPreState - a delete becomes a recreate', () => {
    /** Luau delete path: the server ships no delete tool, so a delete is `execute_luau` + Destroy. */
    const luauGateway = (nodes: string, bag: Record<string, unknown> = {}) =>
        gateway({
            listTools: tools('execute_luau', 'inspect_instance'),
            callTool: async (name: string) => {
                if (name === 'inspect_instance') return JSON.stringify({ properties: { ...bag } });
                return nodes;
            },
        });

    it('captures the tree of an instance destroyed through execute_luau', async () => {
        const snapshot = await snapshotPreState(
            luauGateway(JSON.stringify({
                nodes: [
                    { path: 'Workspace.Model', className: 'Model', name: 'Model' },
                    { path: 'Workspace.Model.Part', className: 'Part', name: 'Part' },
                ],
            })),
            'studio.execute_luau',
            { code: 'workspace.Model:Destroy()', path: 'Workspace.Model', datamodel_type: 'Edit' },
        );
        expect(snapshot.inverse).toHaveLength(1);
        expect(snapshot.inverse[0]).toMatchObject({ tool: 'recreate_instance', path: 'Workspace.Model' });
        expect(isRestorable(snapshot)).toBe(true);
        const tree = (snapshot.inverse[0] as { tree: { children: Array<{ path: string }> } }).tree;
        expect(tree.children.map((child) => child.path)).toEqual(['Workspace.Model.Part']);
    });

    it('leaves a non-deleting Luau as a property snapshot', async () => {
        const snapshot = await snapshotPreState(
            luauGateway('ok', { Transparency: 0 }),
            'studio.execute_luau',
            { code: 'workspace.Part.Transparency = 1', path: 'workspace.Part' },
        );
        expect(snapshot.inverse[0]).toMatchObject({ tool: 'set_properties' });
    });

    it('refuses to claim restorable when the tree cannot be read before the destroy', async () => {
        // Nothing is left to read after the destroy, so a failed capture must be a hard "no".
        const snapshot = await snapshotPreState(
            gateway({
                listTools: tools('execute_luau'),
                callTool: async () => 'error: not found',
            }),
            'studio.delete_instance',
            { path: 'Workspace.Gone' },
        );
        expect(snapshot.inverse).toEqual([]);
        expect(snapshot.notes[0]).toContain('Workspace.Gone');
        expect(isRestorable(snapshot)).toBe(false);
    });
});

describe('pathFromLuau - the target of a delete has to come out of the code', () => {
    it('reads the segment table our own Luau generates', () => {
        expect(pathFromLuau('local segs = {"Workspace", "Model"}\nroot:Destroy()')).toBe('Workspace.Model');
    });

    it('reads a GetService / FindFirstChild chain', () => {
        expect(pathFromLuau('game:GetService("ServerScriptService"):FindFirstChild("E2E"):Destroy()'))
            .toBe('ServerScriptService.E2E');
    });

    it('reads a workspace dot path', () => {
        expect(pathFromLuau('workspace.Model:Destroy()')).toBe('Workspace.Model');
    });

    it('answers null for a shape it cannot read, so nothing is restored by guesswork', () => {
        expect(pathFromLuau('for _, v in ipairs(workspace:GetChildren()) do v:Destroy() end')).toBeNull();
    });

    it('leaves the turn non-restorable when a Luau delete names no readable path', async () => {
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools('execute_luau'), callTool: async () => 'ok' }),
            'studio.execute_luau',
            { code: 'for _, v in ipairs(workspace:GetChildren()) do v:Destroy() end' },
        );
        expect(snapshot.inverse).toEqual([]);
        expect(isRestorable(snapshot)).toBe(false);
    });
});

describe('snapshotPreState - a Luau property write names its target in the code', () => {
    it('snapshots the bag of the instance a Luau move touches', async () => {
        // MEASURED: `workspace.Part.CFrame = …` carries no `path` arg, so without reading the code the
        // most common Studio edit had no inverse at all.
        const calls: string[] = [];
        const snapshot = await snapshotPreState(
            gateway({
                listTools: tools('execute_luau', 'inspect_instance'),
                callTool: async (name: string, args: unknown) => {
                    const code = String((args as { code?: string }).code ?? '');
                    calls.push(name);
                    if (code.includes('GetComponents')) {
                        return JSON.stringify({ key: 'CFrame', components: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], name: 'Part', parentPath: 'Workspace' });
                    }
                    if (name === 'inspect_instance') return JSON.stringify({ properties: { Anchored: true } });
                    return 'none';
                },
            }),
            'studio.execute_luau',
            { code: 'local segs = {"Workspace", "Part"}\nroot.CFrame = CFrame.new(5, 0, 0)', datamodel_type: 'Edit' },
        );
        expect(snapshot.entries[0]).toMatchObject({ kind: 'properties', path: 'Workspace.Part' });
        expect(snapshot.inverse[0]).toMatchObject({ tool: 'set_properties', path: 'Workspace.Part' });
        const properties = (snapshot.entries[0] as { properties: Record<string, unknown> }).properties;
        expect(properties.CFrame).toEqual({
            $cframe: { key: 'CFrame', components: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 0, 0] },
        });
        // Name and Parent are captured too: neither is in the bag, so a rename or a reparent used to
        // have no inverse while the checkpoint still claimed restorable.
        expect(properties.Name).toEqual({ $name: 'Part' });
        expect(properties.Parent).toEqual({ $parent: 'Workspace' });
        expect(calls).toContain('inspect_instance');
        expect(isRestorable(snapshot)).toBe(true);
    });

    it('stays non-restorable when the Luau names no readable instance', async () => {
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools('execute_luau') }),
            'studio.execute_luau',
            { code: 'print("hello")', datamodel_type: 'Edit' },
        );
        expect(snapshot.inverse).toEqual([]);
        expect(isRestorable(snapshot)).toBe(false);
    });
});

describe('snapshotPreState - a Luau snippet that CREATES instances', () => {
    const creatingCode = [
        'local part = Instance.new("Part")',
        'part.Name = "MorphiMadeThis"',
        'part.Parent = game:GetService("Workspace")',
    ].join('\n');

    it('lists the roots before the call, because a creation carries no path in the args', async () => {
        const listing = JSON.stringify({ paths: ['Workspace', 'Workspace.Existing'], truncated: false });
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools('studio.execute_luau'), callTool: async () => listing }),
            'studio.execute_luau',
            { code: creatingCode },
        );
        // No note: "no safe inverse" would be a lie once the diff can find what appeared.
        expect(snapshot.notes).toEqual([]);
        expect(snapshot.insertScan).toEqual({ roots: ['Workspace'], paths: ['Workspace', 'Workspace.Existing'] });
        // Nothing is claimed restorable until the post-state proves what the call actually created.
        expect(isRestorable(snapshot)).toBe(false);
    });

    it('does not list anything for a snippet that creates nothing', async () => {
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools('studio.execute_luau'), callTool: async () => 'ok' }),
            'studio.execute_luau',
            { code: 'print("hello")' },
        );
        expect(snapshot.insertScan).toBeUndefined();
        expect(snapshot.notes).toEqual(['Không có inverse an toàn cho studio.execute_luau.']);
    });

    it('reports a truncated or failed listing instead of diffing it', async () => {
        for (const reply of [JSON.stringify({ paths: [], truncated: true }), 'error: boom', 'not json']) {
            const snapshot = await snapshotPreState(
                gateway({ listTools: tools('studio.execute_luau'), callTool: async () => reply }),
                'studio.execute_luau',
                { code: creatingCode },
            );
            expect(snapshot.insertScan).toBeUndefined();
            expect(snapshot.notes[0]).toContain('Không liệt kê được');
        }
    });

    it('scans the services the code names, not just Workspace', async () => {
        const listing = JSON.stringify({ paths: ['Workspace', 'ServerStorage'], truncated: false });
        const snapshot = await snapshotPreState(
            gateway({ listTools: tools('studio.execute_luau'), callTool: async () => listing }),
            'studio.execute_luau',
            { code: 'local p = Instance.new("Part")\np.Parent = game:GetService("ServerStorage")' },
        );
        expect(snapshot.insertScan?.roots.sort()).toEqual(['ServerStorage', 'Workspace']);
    });
});

describe('snapshotPostState - what the call created', () => {
    it('turns a path that appeared into an inserted entry and a delete inverse', async () => {
        const replies = [
            JSON.stringify({ paths: ['Workspace'], truncated: false }),
            JSON.stringify({ paths: ['Workspace', 'Workspace.MorphiMadeThis'], truncated: false }),
        ];
        let call = 0;
        const mcp = gateway({
            listTools: tools('studio.execute_luau'),
            callTool: async () => replies[Math.min(call++, replies.length - 1)]!,
        });
        const pre = await snapshotPreState(mcp, 'studio.execute_luau', {
            code: 'local part = Instance.new("Part")\npart.Parent = workspace',
        });
        const post = await snapshotPostState(mcp, pre);
        expect(post.created).toEqual(['Workspace.MorphiMadeThis']);
        expect(post.notes).toEqual([]);
    });

    it('creates nothing extra when the pre-listing failed', async () => {
        const mcp = gateway({ listTools: tools('studio.execute_luau'), callTool: async () => 'error: no luau' });
        const pre = await snapshotPreState(mcp, 'studio.execute_luau', { code: 'local p = Instance.new("Part")' });
        const post = await snapshotPostState(mcp, pre);
        expect(post.created).toEqual([]);
    });
});

describe('snapshotPostState - a RENAMED instance is found again by its uniqueId', () => {
    const listings = [
        JSON.stringify({ paths: ['Workspace', 'Workspace.Part'], truncated: false }),
        JSON.stringify({ paths: ['Workspace', 'Workspace.Folder', 'Workspace.Folder.NewPart'], truncated: false }),
    ];

    /** The Luau listing answers phase by phase; `inspect_instance` answers per path. */
    function movingGateway() {
        // The post-state listing is the SECOND one: the first happened before the call and is already
        // stored in `insertScan.paths`.
        let phase = 1;
        return gateway({
            listTools: tools('studio.execute_luau', 'studio.inspect_instance'),
            callTool: async (_name, args) => {
                const record = (args ?? {}) as Record<string, unknown>;
                if (typeof record.code === 'string') {
                    if (record.code.includes('GetComponents')) {
                        return JSON.stringify({ name: 'NewPart', parentPath: 'Workspace.Folder' });
                    }
                    return listings[Math.min(phase++, 1)]!;
                }
                const path = String(record.path ?? '');
                if (path === 'Workspace.Folder.NewPart') {
                    return JSON.stringify({
                        path, name: 'NewPart', className: 'Part', uniqueId: 'uid-1',
                        properties: { Size: '1, 1, 1' },
                    });
                }
                // The snapshot path stopped resolving the moment the rename landed.
                return 'error: not found';
            },
        });
    }

    const pre = (): PreStateSnapshot => ({
        entries: [{
            kind: 'properties' as const,
            path: 'Workspace.Part',
            properties: { Size: '1, 1, 1' },
            uniqueId: 'uid-1',
        }],
        inverse: [{ tool: 'set_properties' as const, path: 'Workspace.Part', properties: { Size: '1, 1, 1' } }],
        notes: [],
        insertScan: { roots: ['Workspace'], paths: ['Workspace', 'Workspace.Part'] },
    });

    it('records the entry at the path it moved to, naming the old one', async () => {
        const post = await snapshotPostState(movingGateway(), pre());
        expect(post.entries).toEqual([{
            kind: 'properties',
            path: 'Workspace.Folder.NewPart',
            fromPath: 'Workspace.Part',
            properties: { Size: '1, 1, 1', Name: { $name: 'NewPart' }, Parent: { $parent: 'Workspace.Folder' } },
        }]);
        expect(post.notes).toEqual([]);
    });

    it('does not call a MOVED instance "created" — deleting it would undo the wrong thing', async () => {
        const post = await snapshotPostState(movingGateway(), pre());
        // The folder the instance was moved INTO is genuinely new, so it is a creation; the instance
        // itself is not, and deleting it would destroy what the rename undo is about to put back.
        expect(post.created).toEqual(['Workspace.Folder']);
    });

    it('keeps the note when it cannot identify the moved instance', async () => {
        const post = await snapshotPostState(gateway({
            listTools: tools('studio.execute_luau', 'studio.inspect_instance'),
            callTool: async (_name, args) => {
                const record = (args ?? {}) as Record<string, unknown>;
                if (typeof record.code === 'string') {
                    return record.code.includes('GetComponents')
                        ? JSON.stringify({ name: 'NewPart', parentPath: 'Workspace.Folder' })
                        : listings[1]!;
                }
                const path = String(record.path ?? '');
                if (path === 'Workspace.Part') return 'error: not found';
                return JSON.stringify({ path, uniqueId: 'uid-OTHER', properties: {} });
            },
        }), pre());
        expect(post.entries).toEqual([]);
        expect(post.notes.join(' ')).toContain('Không đọc lại được thuộc tính');
    });
});
