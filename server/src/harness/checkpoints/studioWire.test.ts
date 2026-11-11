import { describe, expect, it } from 'vitest';
import type { McpGateway } from '../tools/types';
import {
  deleteInstance,
  inspectInstance,
  propertiesFrom,
  readScriptSource,
  restorableProperties,
  scriptSourceFrom,
  setInstanceProperties,
  writeScriptSource,
} from './studioWire';

/**
 * These tests pin the REAL Roblox Studio MCP wire shape, measured live on `Place1`:
 *  - `script_read` answers line-numbered text (`     1→print(1)`), not bare source;
 *  - `multi_edit` takes `file_path` + `edits[{old_string,new_string}]`, never `{path,source}`;
 *  - `inspect_instance` answers a JSON *string* whose `.properties` is the bag;
 *  - there is no delete/set-properties tool, so those go through `execute_luau`.
 * The engine only ever passed in fake mode before this adapter existed, so every assertion here is
 * a case that would have silently failed on a real place.
 */

interface Recording extends McpGateway {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

function gateway(
  tools: Record<string, (args: Record<string, unknown>) => unknown>,
): Recording {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  return {
    connected: true,
    studioLinked: true,
    server: null,
    studio: null,
    toolCount: Object.keys(tools).length,
    lastError: null,
    calls,
    listTools: async () =>
      Object.keys(tools).map((name) => ({ name, description: name, parameters: { type: 'object' } })),
    callTool: async (name: string, args: unknown) => {
      const argsRecord = (args ?? {}) as Record<string, unknown>;
      calls.push({ tool: name, args: argsRecord });
      const handler = tools[name];
      if (handler === undefined) throw new Error(`no such tool: ${name}`);
      return handler(argsRecord);
    },
    reconnect: async () => undefined,
    close: async () => undefined,
  };
}

describe('restorableProperties - the lossy bag', () => {
  /** A trimmed real `Part` bag: the values are exactly what the live server returned. */
  const liveBag = {
    Anchored: true,
    Transparency: 0,
    Reflectance: 0,
    CanCollide: true,
    Locked: false,
    Material: 'Enum.Material.Plastic',
    Shape: 'Enum.PartType.Block',
    Size: '4, 1.2, 2',
    Color: '0.6392157077789307, 0.6352941393852234, 0.6470588445663452',
    BrickColor: 'Medium stone grey',
    Capabilities: '',
    UniqueId: '19bc3a77-ed68-dfe2-0b05-a2ce00000b63',
    CollisionGroup: 'Default',
    MaterialVariant: '',
  };

  it('keeps every scalar as a candidate, including writable strings', () => {
    // A writable string (`CollisionGroup`) and a serialised one (`BrickColor`) are indistinguishable
    // by value, so both stay candidates and `setInstanceProperties` decides key by key, live.
    const restorable = restorableProperties(liveBag);
    expect(restorable.CollisionGroup).toBe('Default');
    expect(restorable.MaterialVariant).toBe('');
    expect(restorable.BrickColor).toBe('Medium stone grey');
    expect(restorable.Anchored).toBe(true);
    expect(restorable.Transparency).toBe(0);
  });

  it('drops flattened pseudo-paths, which are never members', async () => {
    // "CFrame.Position is not a valid member of Part" — a dotted bag key can never be assigned.
    const restorable = restorableProperties({ 'CFrame.Position': '1, 2, 3', 'PivotOffset.Rotation': '0, 0, 0', Transparency: 0.5 });
    expect(restorable).toEqual({ Transparency: 0.5 });
  });

  it('drops non-scalars, which have no literal to emit', () => {
    const restorable = restorableProperties({ Tags: ['a'], Nested: { x: 1 }, Nothing: null, Transparency: 0.5 });
    expect(restorable).toEqual({ Transparency: 0.5 });
  });

  it('returns an empty bag when nothing can be attempted', () => {
    expect(restorableProperties({ 'CFrame.Position': '1, 2, 3' })).toEqual({});
  });
});

describe('scriptSourceFrom - the `N→` prefix', () => {
  it('strips the line-number gutter the real server ships', () => {
        // Measured answer shape from `script_read` on Place1.
    const wire = '     1→local M = {}\n     2→return M';
    expect(scriptSourceFrom(wire)).toBe('local M = {}\nreturn M');
  });

  it('keeps the indentation of the source itself', () => {
    const wire = '     1→if x then\n     2→    print(1)\n     3→end';
    expect(scriptSourceFrom(wire)).toBe('if x then\n    print(1)\nend');
  });

  it('drops the ghost empty line a trailing newline produces', () => {
    // `2→}` on the wire leaves ['', '}', ''] — the terminator must not become a blank last line.
    const wire = '     1→local a = 1\n     2→}\n';
    expect(scriptSourceFrom(wire)).toBe('local a = 1\n}');
  });

  it('leaves a non-numbered string alone instead of mangling it', () => {
    // A fake gateway or an error sentence has no gutter; stripping must be a no-op.
    expect(scriptSourceFrom('local Old = {}')).toBe('local Old = {}');
  });

  it('accepts a legacy `{ source }` object from a fake gateway', () => {
    expect(scriptSourceFrom({ source: 'raw' })).toBe('raw');
  });

  it('returns null when nothing usable came back', () => {
    expect(scriptSourceFrom(null)).toBeNull();
    expect(scriptSourceFrom(undefined)).toBeNull();
    expect(scriptSourceFrom({ unexpected: 1 })).toBeNull();
  });
});

describe('propertiesFrom - the JSON-string inspect answer', () => {
  it('parses the `.properties` bag out of the JSON text string', () => {
    const wire = JSON.stringify({ path: 'Workspace.Part', className: 'Part', properties: { Transparency: 0.5 } });
    expect(propertiesFrom(wire)).toEqual({ Transparency: 0.5 });
  });

  it('digs through `.instance.properties` when the answer nests it', () => {
    const wire = JSON.stringify({ instance: { properties: { Anchored: true } } });
    expect(propertiesFrom(wire)).toEqual({ Anchored: true });
  });

  it('accepts a legacy `{ properties }` object', () => {
    expect(propertiesFrom({ properties: { Size: 2 } })).toEqual({ Size: 2 });
  });

  it('returns null for a non-JSON answer rather than throwing', () => {
    expect(propertiesFrom('not json')).toBeNull();
  });
});

describe('readScriptSource', () => {
  it('calls the real `script_read` with `target_file` and asks for the whole file', async () => {
    const mcp = gateway({ script_read: () => '     1→local A = 1' });
    const source = await readScriptSource(mcp, 'ReplicatedStorage.A');
    expect(source).toBe('local A = 1');
    expect(mcp.calls[0]).toEqual({
      tool: 'script_read',
      args: { target_file: 'ReplicatedStorage.A', should_read_entire_file: true },
    });
  });

  it('uses `path` for the legacy studio.* alias so fake gateways keep working', async () => {
    const mcp = gateway({ 'studio.script_read': () => 'old' });
    await readScriptSource(mcp, 'A');
    expect(mcp.calls[0]?.args).toEqual({ path: 'A' });
  });

  it('returns null when the tool is missing, instead of pretending it read something', async () => {
    const mcp = gateway({});
    expect(await readScriptSource(mcp, 'A')).toBeNull();
  });
});

describe('writeScriptSource', () => {
  it('creates a script with an empty old_string when nothing exists yet', async () => {
    const mcp = gateway({ multi_edit: () => 'ok' });
    await writeScriptSource(mcp, 'ReplicatedStorage.A', 'local A = 2');
    expect(mcp.calls[0]).toEqual({
      tool: 'multi_edit',
      args: {
        file_path: 'ReplicatedStorage.A',
        datamodel_type: 'Edit',
        className: 'Script',
        edits: [{ old_string: '', new_string: 'local A = 2' }],
      },
    });
  });

  it('replaces exactly by using the CURRENT source as old_string', async () => {
    // MEASURED LIVE: `old_string: ''` appends instead of replacing, so a rewrite built on an empty
    // old_string produces `new..old` and corrupts the script. This is the regression guard.
    const mcp = gateway({
      script_read: () => '     1→local A = 1',
      multi_edit: () => 'Modified A (Script) with 1 edits applied',
    });
    await writeScriptSource(mcp, 'ReplicatedStorage.A', 'local A = 2');
    const write = mcp.calls.find((call) => call.tool === 'multi_edit');
    expect(write?.args.edits).toEqual([{ old_string: 'local A = 1', new_string: 'local A = 2' }]);
  });

  it('throws when no write tool exists, which the engine reports as a failure', async () => {
    const mcp = gateway({});
    await expect(writeScriptSource(mcp, 'A', 'x')).rejects.toThrow('ghi script');
  });
});

describe('deleteInstance', () => {
  it('destroys through execute_luau and confirms the instance is really gone', async () => {
    const mcp = gateway({
      execute_luau: (args) => {
        // The adapter sends a destroy pass, then a read-only presence probe.
        return String(args.code).includes(':Destroy()') ? 'ok' : 'missing';
      },
    });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(true);
    const destroy = mcp.calls[0];
    expect(destroy?.tool).toBe('execute_luau');
    expect(destroy?.args.datamodel_type).toBe('Edit');
    expect(String(destroy?.args.code)).toContain(':Destroy()');
    // Services must be resolved via GetService, and children via FindFirstChild: indexing an
    // Instance with a missing name throws, so `root[name]` cannot express "not there".
    expect(String(destroy?.args.code)).toContain('GetService');
    expect(String(destroy?.args.code)).toContain('FindFirstChild');
    // MEASURED LIVE: a JSON array literal is a Luau parse error ("Failed to parse command code"),
    // which is why the first delete implementation silently removed nothing.
    expect(String(destroy?.args.code)).toContain('local segs = {"Workspace", "Tree"}');
  });

  it('reports failure when the path does not exist instead of claiming a delete', async () => {
    // MEASURED LIVE: returning "deleted" unconditionally left every probe script in the place.
    const mcp = gateway({ execute_luau: () => 'error: not found' });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(false);
  });

  it('reports failure when the destroy ran but the instance is still there', async () => {
    const mcp = gateway({
      execute_luau: (args) => (String(args.code).includes(':Destroy()') ? 'ok' : 'exists'),
    });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(false);
  });

  it('reports failure when the Luau answer is an error sentence', async () => {
    const mcp = gateway({ execute_luau: () => 'error: attempt to index nil' });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(false);
  });
});

describe('setInstanceProperties', () => {
  /** The Luau reports through HttpService:JSONEncode so the adapter parses rather than scrapes. */
  const report = (applied: string[], failed: Array<{ key: string; reason: string }> = []) =>
    JSON.stringify({ applied, failed });

  it('binds the instance before indexing it, so the Luau can actually run', async () => {
    // An earlier version emitted `inst[key] = ...` with no `inst` local — invalid Luau every time.
    const mcp = gateway({ execute_luau: () => report(['Transparency']) });
    await setInstanceProperties(mcp, 'Workspace.Part', { Transparency: 0.5 });
    const code = String(mcp.calls[0]?.args.code);
    expect(code).toContain('local inst = root');
    expect(code).toContain('attempt("Transparency", 0.5)');
  });

  it('isolates every key in its own pcall so one refusal cannot fail the rest', async () => {
    // MEASURED LIVE: an unconditional re-apply threw on the first bad key ("Vector3 expected, got
    // string") and failed the whole restore.
    const mcp = gateway({
      execute_luau: () => report(['Transparency', 'Anchored'], [{ key: 'Size', reason: 'Vector3 expected, got string' }]),
    });
    const written = await setInstanceProperties(mcp, 'Workspace.Part', { Transparency: 0, Anchored: true, Size: '4, 1.2, 2' });
    expect(written.applied).toEqual(['Transparency', 'Anchored']);
    expect(written.skipped).toEqual([{ key: 'Size', reason: 'Vector3 expected, got string' }]);
    const code = String(mcp.calls[0]?.args.code);
    expect(code).toContain("local ok, err = pcall(function() inst[key] = value end)");
    expect(code).toContain('HttpService');
  });

  it('escapes a property value that needs quoting', async () => {
    const mcp = gateway({ execute_luau: () => report(['CollisionGroup']) });
    await setInstanceProperties(mcp, 'Workspace.Part', { CollisionGroup: 'has "quotes"' });
    expect(String(mcp.calls[0]?.args.code)).toContain('attempt("CollisionGroup", "has \\"quotes\\"")');
  });

  it('prefers a dedicated property tool when a fake gateway exposes one', async () => {
    const mcp = gateway({ 'studio.set_properties': () => ({ ok: true }) });
    expect(await setInstanceProperties(mcp, 'A', { X: 1 })).toEqual({ applied: ['X'], skipped: [] });
    expect(mcp.calls[0]).toEqual({ tool: 'studio.set_properties', args: { path: 'A', properties: { X: 1 } } });
  });

  it('throws instead of assuming success when the report cannot be parsed', async () => {
    const mcp = gateway({ execute_luau: () => 'ok' });
    await expect(setInstanceProperties(mcp, 'A', { X: 1 })).rejects.toThrow('không trả về kết quả đọc được');
  });
});

describe('inspectInstance', () => {
  it('calls `inspect_instance` with the dot path and returns the bag', async () => {
    const mcp = gateway({
      inspect_instance: () => JSON.stringify({ properties: { Anchored: true } }),
    });
    expect(await inspectInstance(mcp, 'Workspace.Part')).toEqual({ Anchored: true });
    expect(mcp.calls[0]?.args).toEqual({ path: 'Workspace.Part' });
  });

  it('returns null for an unreadable instance so drift is reported, not guessed', async () => {
    const mcp = gateway({ inspect_instance: () => 'not json' });
    expect(await inspectInstance(mcp, 'Workspace.Part')).toBeNull();
  });
});
