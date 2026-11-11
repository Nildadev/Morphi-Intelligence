import { describe, expect, it } from 'vitest';
import type { McpGateway, ToolSchema } from '../tools/types';
import {
  captureCframe,
  captureInstanceTree,
  deleteInstance,
  inspectInstance,
  instanceExists,
  propertiesFrom,
  recreateInstance,
  reconstructValue,
  readScriptSource,
  restorableProperties,
  sameCframe,
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
 *
 * REAL vs LEGACY is decided by `speaksRealShape` (schema-first, name-fallback), NOT by the name
 * prefix. The app's own `ServiceMcpGateway` publishes the real tools PREFIXED (`studio.script_read`),
 * while the raw server uses unprefixed names — so a prefix heuristic sends the wrong args and, through
 * the app gateway, every snapshot read fails while all fake-gateway tests stay green. The HTTP
 * end-to-end caught this; the gateway factories below reproduce both shapes.
 */

interface Recording extends McpGateway {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

/** Raw server (live probe): unprefixed names, real schemas. */
function rawGateway(
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
      Object.keys(tools).map((name) => ({
        name,
        description: name,
        parameters: { type: 'object', properties: { target_file: {}, file_path: {}, code: {}, path: {} } },
      })),
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

/** App's ServiceMcpGateway: PREFIXED names, but forwards the REAL schema (target_file/file_path/code). */
function appGateway(
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
      Object.keys(tools).map((name) => ({
        name: `studio.${name}`,
        description: name,
        parameters: { type: 'object', properties: { target_file: {}, file_path: {}, code: {}, path: {} } },
      })),
    callTool: async (name: string, args: unknown) => {
      const argsRecord = (args ?? {}) as Record<string, unknown>;
      calls.push({ tool: name, args: argsRecord });
      const handler = tools[name.replace(/^studio\./, '')];
      if (handler === undefined) throw new Error(`no such tool: ${name}`);
      return handler(argsRecord);
    },
    reconnect: async () => undefined,
    close: async () => undefined,
  };
}

/** Legacy fake gateway (E2E fixtures): prefixed names, NO discriminating schema property. */
function legacyGateway(
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
    // A writable string (`CollisionGroup`) and a serialised one (`MaterialVariant`) are
    // indistinguishable by value, so both stay candidates and `setInstanceProperties` decides key by
    // key, live. BrickColor is NOT a candidate: writing it would fight `Color` (measured live).
    const restorable = restorableProperties(liveBag);
    expect(restorable.CollisionGroup).toBe('Default');
    expect(restorable.MaterialVariant).toBe('');
    expect(restorable.BrickColor).toBeUndefined();
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
    const mcp = rawGateway({ script_read: () => '     1→local A = 1' });
    const source = await readScriptSource(mcp, 'ReplicatedStorage.A');
    expect(source).toBe('local A = 1');
    expect(mcp.calls[0]).toEqual({
      tool: 'script_read',
      args: { target_file: 'ReplicatedStorage.A', should_read_entire_file: true },
    });
  });

  it('uses `path` for the raw server tool (unprefixed name, real schema is still real shape)', async () => {
    const mcp = rawGateway({ script_read: () => 'old' });
    await readScriptSource(mcp, 'A');
    expect(mcp.calls[0]?.args).toEqual({ target_file: 'A', should_read_entire_file: true });
  });

  it('returns null when the tool is missing, instead of pretending it read something', async () => {
    const mcp = rawGateway({});
    expect(await readScriptSource(mcp, 'A')).toBeNull();
  });
});

describe('writeScriptSource', () => {
  it('creates a script with an empty old_string when nothing exists yet', async () => {
    const mcp = rawGateway({ multi_edit: () => 'ok' });
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
    const mcp = rawGateway({
      script_read: () => '     1→local A = 1',
      multi_edit: () => 'Modified A (Script) with 1 edits applied',
    });
    await writeScriptSource(mcp, 'ReplicatedStorage.A', 'local A = 2');
    const write = mcp.calls.find((call) => call.tool === 'multi_edit');
    expect(write?.args.edits).toEqual([{ old_string: 'local A = 1', new_string: 'local A = 2' }]);
  });

  it('throws when no write tool exists, which the engine reports as a failure', async () => {
    const mcp = rawGateway({});
    await expect(writeScriptSource(mcp, 'A', 'x')).rejects.toThrow('ghi script');
  });
});

describe('deleteInstance', () => {
  it('destroys through execute_luau and confirms the instance is really gone', async () => {
    const mcp = rawGateway({
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
    const mcp = rawGateway({ execute_luau: () => 'error: not found' });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(false);
  });

  it('reports failure when the destroy ran but the instance is still there', async () => {
    const mcp = rawGateway({
      execute_luau: (args) => (String(args.code).includes(':Destroy()') ? 'ok' : 'exists'),
    });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(false);
  });

  it('reports failure when the Luau answer is an error sentence', async () => {
    const mcp = rawGateway({ execute_luau: () => 'error: attempt to index nil' });
    expect(await deleteInstance(mcp, 'Workspace.Tree')).toBe(false);
  });
});

describe('setInstanceProperties', () => {
  /** The Luau reports through HttpService:JSONEncode so the adapter parses rather than scrapes. */
  const report = (applied: string[], failed: Array<{ key: string; reason: string }> = []) =>
    JSON.stringify({ applied, failed });

  it('binds the instance before indexing it, so the Luau can actually run', async () => {
    // An earlier version emitted `inst[key] = ...` with no `inst` local — invalid Luau every time.
    const mcp = rawGateway({ execute_luau: () => report(['Transparency']) });
    await setInstanceProperties(mcp, 'Workspace.Part', { Transparency: 0.5 });
    const code = String(mcp.calls[0]?.args.code);
    expect(code).toContain('local inst = root');
    expect(code).toContain('attempt("Transparency", 0.5)');
  });

  it('isolates every key in its own pcall so one refusal cannot fail the rest', async () => {
    // MEASURED LIVE: an unconditional re-apply threw on the first bad key ("Vector3 expected, got
    // string") and failed the whole restore.
    const mcp = rawGateway({
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
    const mcp = rawGateway({ execute_luau: () => report(['CollisionGroup']) });
    await setInstanceProperties(mcp, 'Workspace.Part', { CollisionGroup: 'has "quotes"' });
    expect(String(mcp.calls[0]?.args.code)).toContain('attempt("CollisionGroup", "has \\"quotes\\"")');
  });

  it('prefers a dedicated property tool when a fake gateway exposes one', async () => {
    const mcp = legacyGateway({ 'studio.set_properties': () => ({ ok: true }) });
    expect(await setInstanceProperties(mcp, 'A', { X: 1 })).toEqual({ applied: ['X'], skipped: [] });
    expect(mcp.calls[0]).toEqual({ tool: 'studio.set_properties', args: { path: 'A', properties: { X: 1 } } });
  });

  it('throws instead of assuming success when the report cannot be parsed', async () => {
    const mcp = rawGateway({ execute_luau: () => 'ok' });
    await expect(setInstanceProperties(mcp, 'A', { X: 1 })).rejects.toThrow('không trả về kết quả đọc được');
  });
});

describe('inspectInstance', () => {
  it('calls `inspect_instance` with the dot path and returns the bag', async () => {
    const mcp = rawGateway({
      inspect_instance: () => JSON.stringify({ properties: { Anchored: true } }),
    });
    expect(await inspectInstance(mcp, 'Workspace.Part')).toEqual({ Anchored: true });
    expect(mcp.calls[0]?.args).toEqual({ path: 'Workspace.Part' });
  });

  it('returns null for an unreadable instance so drift is reported, not guessed', async () => {
    const mcp = rawGateway({ inspect_instance: () => 'not json' });
    expect(await inspectInstance(mcp, 'Workspace.Part')).toBeNull();
  });
});

describe('gateway-shape detection (the HTTP end-to-end bug)', () => {
  // The app's ServiceMcpGateway publishes the real tools PREFIXED (`studio.script_read`) but forwards
  // the real schema. A name-prefix heuristic would treat them as legacy and send `{path}`/`{source}`,
  // which the real server rejects — every snapshot read fails while fake-gateway tests stay green.
  // `speaksRealShape` must key off the schema, so the app gateway speaks the real args.

  it('reads with target_file through the app gateway (prefixed name, real schema)', async () => {
    const mcp = appGateway({ script_read: () => '     1→local A = 1' });
    const source = await readScriptSource(mcp, 'ReplicatedStorage.A');
    expect(source).toBe('local A = 1');
    expect(mcp.calls[0]).toEqual({
      tool: 'studio.script_read',
      args: { target_file: 'ReplicatedStorage.A', should_read_entire_file: true },
    });
  });

  it('writes with file_path/edits through the app gateway (prefixed name, real schema)', async () => {
    const mcp = appGateway({ multi_edit: () => 'ok' });
    await writeScriptSource(mcp, 'ReplicatedStorage.A', 'local A = 2');
    expect(mcp.calls[0]).toEqual({
      tool: 'studio.multi_edit',
      args: {
        file_path: 'ReplicatedStorage.A',
        datamodel_type: 'Edit',
        className: 'Script',
        edits: [{ old_string: '', new_string: 'local A = 2' }],
      },
    });
  });

  it('still speaks {path} for a genuinely legacy fake gateway (prefixed, no schema)', async () => {
    const mcp = legacyGateway({ 'studio.script_read': () => 'old' });
    await readScriptSource(mcp, 'A');
    expect(mcp.calls[0]?.args).toEqual({ path: 'A' });
  });
});



describe('reconstructValue - Enums', () => {
  it('emits an Enum item as the Luau expression Studio actually accepts', async () => {
    // MEASURED: the bag carries `Material: "Enum.Material.Plastic"`. Writing that back as a STRING
    // fails with `Invalid value "Enum.Material.Plastic"`, so every enum property used to land in
    // `skipped` on a restore — the value was recoverable, it was just quoted.
    const mcp = rawGateway({ execute_luau: () => JSON.stringify({ applied: ['Material'], failed: [] }) });
    await setInstanceProperties(mcp, 'Workspace.Part', { Material: 'Enum.Material.Plastic' });
    const code = String(mcp.calls[0]?.args.code);
    expect(code).toContain('attempt("Material", Enum.Material.Plastic)');
    expect(code).not.toContain('"Enum.Material.Plastic"');
  });

  it('refuses to turn a non-identifier Enum-looking string into code', async () => {
    const mcp = rawGateway({ execute_luau: () => JSON.stringify({ applied: [], failed: [] }) });
    await setInstanceProperties(mcp, 'Workspace.Part', { Material: 'Enum.Material.Plastic; os.exit()' });
    const code = String(mcp.calls[0]?.args.code);
    // Quoted, i.e. a Luau string literal that the pcall rejects — never a bare expression.
    expect(code).toContain('attempt("Material", "Enum.Material.Plastic; os.exit()")');
  });
});

describe('captureInstanceTree / recreateInstance', () => {
  const outline = (nodes: Array<{ path: string; className: string; name: string }>) =>
    JSON.stringify({ nodes });

  it('captures the subtree before the destroy, children under their parent', async () => {
    const mcp = rawGateway({
      execute_luau: () =>
        outline([
          { path: 'Workspace.Model', className: 'Model', name: 'Model' },
          { path: 'Workspace.Model.Part', className: 'Part', name: 'Part' },
          { path: 'Workspace.Model.Part.Decal', className: 'Decal', name: 'Decal' },
        ]),
      inspect_instance: (args) =>
        JSON.stringify({
          properties: { ClassName: 'Part', Material: 'Enum.Material.Plastic', Size: '4, 1.2, 2' },
          name: String(args.path),
        }),
    });
    const tree = await captureInstanceTree(mcp, 'Workspace.Model');
    expect(tree).toMatchObject({ path: 'Workspace.Model', className: 'Model' });
    expect(tree?.children.map((child) => child.path)).toEqual(['Workspace.Model.Part']);
    expect(tree?.children[0].children.map((child) => child.path)).toEqual(['Workspace.Model.Part.Decal']);
    expect(tree?.children[0].properties).toMatchObject({ Material: 'Enum.Material.Plastic' });
  });

  it('returns null when the path does not resolve, instead of an empty tree', async () => {
    // An empty tree would restore as "nothing to do" and the delete would look undone.
    const mcp = rawGateway({ execute_luau: () => 'error: not found' });
    expect(await captureInstanceTree(mcp, 'Workspace.Gone')).toBeNull();
  });

  it('recreates parent first, then children, with real constructors', async () => {
    const created: string[] = [];
    const mcp = rawGateway({
      execute_luau: (args) => {
        const code = String(args.code);
        const name = /inst\.Name = "(.*)"/.exec(code)?.[1] ?? '';
        created.push(name);
        return JSON.stringify({ ok: true, failed: [] });
      },
    });
    const result = await recreateInstance(mcp, 'Workspace.Model', {
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
    });
    expect(result.created).toEqual(['Workspace.Model', 'Workspace.Model.Part']);
    expect(created).toEqual(['Model', 'Part']);
  });

  it('reports the properties Studio refused instead of failing the whole recreate', async () => {
    const mcp = rawGateway({
      execute_luau: () => JSON.stringify({ ok: true, failed: [{ key: 'Capabilities', reason: 'SecurityCapabilities expected' }] }),
    });
    const result = await recreateInstance(mcp, 'W.A', {
      path: 'W.A', className: 'Part', name: 'A', properties: { Capabilities: '' }, children: [],
    });
    expect(result.created).toEqual(['W.A']);
    expect(result.skipped).toEqual([{ path: 'W.A', key: 'Capabilities', reason: 'SecurityCapabilities expected' }]);
  });

  it('reports a refused class name instead of pretending the node came back', async () => {
    const mcp = rawGateway({ execute_luau: () => 'error: cannot create Terrain' });
    const result = await recreateInstance(mcp, 'W.T', {
      path: 'W.T', className: 'Terrain', name: 'T', properties: {}, children: [],
    });
    expect(result.created).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ path: 'W.T', key: 'ClassName' });
  });
});

describe('properties no restore can write', () => {
  it('drops the capability-locked keys at capture time, so `skipped` only means real loss', async () => {
    // MEASURED LIVE: every undo listed UniqueId, Capabilities and ExplorerIconContent, each refused
    // in Studio's own words. Listing them every time teaches the user to ignore the report.
    const restorable = restorableProperties({
      UniqueId: 'u', Capabilities: '', ExplorerIconContent: '', RobloxLocked: false,
      ClassName: 'Part', Parent: 'x', Material: 'Enum.Material.Plastic', Anchored: true,
    });
    expect(restorable).toEqual({ Material: 'Enum.Material.Plastic', Anchored: true });
  });

  it('retries a comma-triple as Color3 when Studio refuses it as a Vector3', async () => {
    // `Color` and `Size` both arrive as "x, y, z"; emitting Vector3 for Color was refused live.
    const mcp = rawGateway({ execute_luau: () => JSON.stringify({ applied: ['Color'], failed: [] }) });
    await setInstanceProperties(mcp, 'Workspace.Part', { Color: '0.6, 0.6, 0.6' });
    const code = String(mcp.calls[0]?.args.code);
    expect(code).toContain('Vector3.new(0.6, 0.6, 0.6)');
    expect(code).toContain('Color3.new(value.X, value.Y, value.Z)');
  });
});

describe('reconstructValue - BrickColor is left out on purpose', () => {
  it('never writes BrickColor, because it would override the exact Color', async () => {
    // MEASURED LIVE: a part whose Color was 200,40,90 came back 205,84,75 — Neon's colour — because
    // `BrickColor = "Neon"` was assigned after `Color` and won. Color round-trips exactly; the legacy
    // mirror must not be written at all.
    const bag = restorableProperties({ Color: '0.78, 0.16, 0.35', BrickColor: 'Neon', Material: 'Enum.Material.Neon' });
    expect(bag.BrickColor).toBeUndefined();
    const mcp = rawGateway({ execute_luau: () => JSON.stringify({ applied: [], failed: [] }) });
    await setInstanceProperties(mcp, 'Workspace.Part', bag);
    expect(String(mcp.calls[0]?.args.code)).not.toContain('BrickColor');
  });

  it('still leaves a plain string property a plain string', async () => {
    const mcp = rawGateway({ execute_luau: () => JSON.stringify({ applied: [], failed: [] }) });
    await setInstanceProperties(mcp, 'Workspace.Part', { CollisionGroup: 'Default', MaterialVariant: 'Wood Grain' });
    const code = String(mcp.calls[0]?.args.code);
    expect(code).toContain('attempt("CollisionGroup", "Default")');
    expect(code).toContain('attempt("MaterialVariant", "Wood Grain")');
    expect(code).not.toContain('BrickColor.new');
  });
});

describe('captureCframe / reconstructValue - the transform', () => {
  const json = (key: string, components: number[]) => JSON.stringify({ key, components });

  it('reads the twelve components of a Part CFrame', async () => {
    const mcp = rawGateway({
      execute_luau: () => json('CFrame', [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    });
    const captured = await captureCframe(mcp, 'Workspace.Part');
    expect(captured).toEqual({
      key: 'CFrame',
      components: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      position: [1, 2, 3],
    });
  });

  it('falls back to a Model WorldPivot, which is the transform a Model actually owns', async () => {
    const mcp = rawGateway({ execute_luau: () => json('WorldPivot', [5, 6, 7, 1, 0, 0, 0, 1, 0, 0, 0, 1]) });
    expect((await captureCframe(mcp, 'Workspace.Model'))?.key).toBe('WorldPivot');
  });

  it('answers null for an instance with no transform, so no member is invented', async () => {
    // A Script/Folder/ScreenGui has neither CFrame nor WorldPivot; writing one would fail the restore.
    const mcp = rawGateway({ execute_luau: () => 'none' });
    expect(await captureCframe(mcp, 'ServerScriptService.Main')).toBeNull();
  });

  it('answers null when the read itself failed', async () => {
    const mcp = rawGateway({ execute_luau: () => 'error: attempt to index nil' });
    expect(await captureCframe(mcp, 'Workspace.Gone')).toBeNull();
  });

  it('reconstructs the CFrame.new(x,y,z, R00..R21) literal, rotation included', async () => {
    // 90° about the Y axis: the rotation is the half of a move a user notices first.
    const literal = reconstructValue({
      $cframe: { key: 'CFrame', components: [0, 5, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0], position: [0, 5, 0] },
    });
    expect(literal).toBe('CFrame.new(0, 5, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0)');
  });

  it('compares transforms as a matrix with float tolerance', async () => {
    const marker = { $cframe: { key: 'CFrame' as const, components: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 2, 3] } };
    expect(sameCframe(marker, { key: 'CFrame', components: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 2, 3] })).toBe(true);
    expect(sameCframe(marker, { key: 'CFrame', components: [1, 2, 3.00001, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 2, 3] })).toBe(true);
    expect(sameCframe(marker, { key: 'CFrame', components: [1, 2, 4, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 2, 4] })).toBe(false);
    expect(sameCframe(marker, null)).toBe(false);
    expect(sameCframe(undefined, { key: 'CFrame', components: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 2, 3] })).toBe(false);
  });
});
