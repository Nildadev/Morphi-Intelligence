import type { McpGateway } from '../tools/types';

/**
 * Wire adapter for the OFFICIAL Roblox Studio MCP server.
 *
 * Phase 3 wrote the snapshot/restore engine against a *guessed* tool surface
 * (`studio.write_script`, `studio.delete_instance`, `studio.set_properties`, a `script_read` that
 * returned plain source text, …). The real server — measured live on `Place1` — exposes a different
 * surface, so the engine only ever worked in fake/E2E mode and would have failed on a real place:
 *
 *  - Script source is read with `script_read` (`target_file`, dot notation) and returned as
 *    line-numbered text: `     1→print(1)\n     2→return {}`. There is NO `studio.*` namespace,
 *    no `path` argument, and no plain-source return.
 *  - Script source is written with `multi_edit` (`file_path`, dot notation, `edits: [{ old_string,
 *    new_string }]`, `datamodel_type`). MEASURED ON A LIVE PLACE: `old_string: ''` **appends** to the
 *    script, it does not replace it — so a "full rewrite" through an empty old_string concatenates
 *    the old text onto the new and corrupts the script. An exact replace requires `old_string` equal
 *    to the script's current source. `writeScriptSource` therefore reads first and rewrites against
 *    the real current text; `old_string: ''` is used only to CREATE a script that does not exist.
 *    `multi_edit` creates scripts when the path is missing (needs `className`).
 *  - Instances are inspected with `inspect_instance` (`path`) and returned as a JSON *text* string
 *    whose `.properties` bag is what a property restore re-applies.
 *  - There is no `delete_instance` / `set_properties` / `write_script` tool at all. A delete is done
 *    with `execute_luau`; property writes likewise have no dedicated inverse tool.
 *
 *  - `inspect_instance` property bags are LOSSY. Measured on a plain `Part`: 36 keys, of which 20
 *    cannot be written back — `CFrame.Position`/`PivotOffset.Rotation` are flattened pseudo-paths
 *    ("… is not a valid member of Part"), `Size`/`Color`/`Rotation` arrive as comma-joined strings
 *    ("Vector3 expected, got string"), enums arrive as `"Enum.Material.Plastic"` and `UniqueId` is
 *    capability-locked. Re-applying the raw bag therefore threw on the first bad key and failed
 *    every property restore, so `restorableProperties` filters the bag to the keys that round-trip.
 *
 * This module is the ONLY place that knows the real wire shape. It accepts the gateway's normalised
 * string return (`resultText` in `serviceGateway` already flattens `content[].text`), but it also
 * tolerates a fake gateway that returns a raw `{ source }` / `{ properties }` object (E2E tests), so
 * the existing 696 server tests keep passing unchanged.
 *
 * Tool-name resolution is preference-ordered: the real names (`script_read`, `multi_edit`,
 * `inspect_instance`) are tried first, then the legacy `studio.*` aliases (used by E2E fake tools),
 * so the same engine drives both surfaces.
 */

const SCRIPT_READ_CANDIDATES = ['script_read', 'studio.script_read', 'studio.read_script'] as const;
/** Legacy aliases (fake/E2E gateways) take `{ path, source }`; the real tool takes `file_path`+`edits`. */
const SCRIPT_WRITE_CANDIDATES = ['multi_edit', 'studio.multi_edit', 'studio.write_script', 'studio.edit_script', 'studio.create_script'] as const;
const INSPECT_CANDIDATES = ['inspect_instance', 'studio.inspect_instance'] as const;
const LUAU_CANDIDATES = ['execute_luau', 'studio.execute_luau'] as const;

const DATAMODEL = 'Edit';

/** One thing the mutation can be undone from. */
export type SnapshotEntry =
  | { kind: 'script'; path: string; source: string }
  | { kind: 'properties'; path: string; properties: Record<string, unknown> }
  | { kind: 'inserted'; path: string };

export type InverseStep =
  | { tool: 'script_write'; path: string; source: string }
  | { tool: 'set_properties'; path: string; properties: Record<string, unknown> }
  | { tool: 'delete_instance'; path: string };

/** Normalise a `script_read` answer to bare source text (strips `N→` line prefixes). */
export function scriptSourceFrom(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  let text: string;
  if (typeof result === 'string') text = result;
  else if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    // Real gateway returns `{ source }`? No — but the fake one might. Accept it.
    if (typeof record.source === 'string') return record.source;
    if (typeof record.text === 'string') text = record.text;
    else if (Array.isArray(record.content)) {
      const part = (record.content as Array<{ text?: string }>).find((p) => typeof p?.text === 'string');
      if (!part) return null;
      text = part.text!;
    } else return null;
  } else return null;

  return stripLineNumbers(text);
}

/**
 * `script_read` ships `     1→print(1)\n     2→return {}` — the prefix is whitespace + `N→`.
 * Strip it so the snapshot stores exactly the source Studio would round-trip back. A line that does
 * not match the `N→` shape (e.g. an error string from the fake gateway) is returned untouched.
 */
function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const stripped = lines.map((line) => {
    const match = /^(\s*\d+→)(.*)$/.exec(line);
    return match ? match[2] : line;
  });
  // A trailing newline produces a ghost empty element on the real server (`2→}`` → ['', '}', '']`).
  // Drop a single terminating empty so the snapshot/restore comparison is exact.
  if (stripped.length > 0 && stripped[stripped.length - 1] === '') stripped.pop();
  return stripped.join('\n');
}

/** Properties bag from an `inspect_instance` answer (which arrives as a JSON *text* string). */
export function propertiesFrom(result: unknown): Record<string, unknown> | null {
  if (result === null || result === undefined) return null;
  let text: string;
  if (typeof result === 'string') text = result;
  else if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record.properties !== null && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
      return record.properties as Record<string, unknown>;
    }
    if (typeof record.text === 'string') text = record.text;
    else return null;
  } else return null;

  // Real server: a JSON string. Parse it and dig out `.properties` (and `.instance.properties`).
  try {
    const parsed = JSON.parse(text);
    if (parsed?.properties !== null && typeof parsed?.properties === 'object') return parsed.properties;
    if (parsed?.instance?.properties !== null && typeof parsed?.instance?.properties === 'object') {
      return parsed.instance.properties;
    }
  } catch {
    /* not JSON — falls through to null */
  }
  return null; }

/** Pick the first candidate the gateway actually exposes; undefined ⇒ the capability is absent. */
async function pickTool(
  mcp: McpGateway,
  candidates: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  let available: Set<string>;
  try {
    available = new Set((await mcp.listTools()).map((tool) => tool.name));
  } catch {
    return undefined;
  }
  return candidates.find((name) => available.has(name));
}

/** Read a script's current source, or null when the tool is absent / the path cannot be read. */
export async function readScriptSource(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const tool = await pickTool(mcp, SCRIPT_READ_CANDIDATES, signal);
  if (tool === undefined) return null;
  // The real `script_read` keys on `target_file` and wants the whole file; the legacy `studio.*`
  // aliases (fake/E2E gateways) key on `path`. Sending the wrong one reads nothing back.
  const args = tool.startsWith('studio.')
    ? { path }
    : { target_file: path, should_read_entire_file: true };
  try {
    const result = await mcp.callTool(tool, args, signal);
    return scriptSourceFrom(result);
  } catch {
    return null;
  }
}

/** Read an instance's property bag, or null when the tool is absent / the path cannot be inspected. */
export async function inspectInstance(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const tool = await pickTool(mcp, INSPECT_CANDIDATES, signal);
  if (tool === undefined) return null;
  try {
    const result = await mcp.callTool(tool, { path }, signal);
    return propertiesFrom(result);
  } catch {
    return null;
  }
}

/**
 * Write a full source back to a script.
 *
 * `multi_edit` treats `old_string: ''` as "append", which was measured live: rewriting with an empty
 * old_string produced `new .. old` and corrupted the script. So this reads the current source first
 * and replaces it exactly. Only a script that does not exist yet is created from an empty
 * `old_string`, which is the one case where append and create agree.
 *
 * Returns the raw tool result so the caller can verify, or throws on failure (a silent OK is a lie).
 */
export async function writeScriptSource(
  mcp: McpGateway,
  path: string,
  source: string,
  signal?: AbortSignal,
  options: { className?: string } = {},
): Promise<unknown> {
  const tool = await pickTool(mcp, SCRIPT_WRITE_CANDIDATES, signal);
  if (tool === undefined) throw new Error('Studio không mở công cụ ghi script để khôi phục.');
  // The legacy aliases speak `{ path, source }`; the real `multi_edit` speaks `file_path` + `edits`.
  if (tool.startsWith('studio.')) return mcp.callTool(tool, { path, source }, signal);

  const current = await readScriptSource(mcp, path, signal);
  const exists = current !== null && current !== '';
  // An empty script is indistinguishable from a missing one here; appending onto nothing is exact.
  const oldString = exists ? current! : '';
  return mcp.callTool(
    tool,
    {
      file_path: path,
      datamodel_type: DATAMODEL,
      className: options.className ?? 'Script',
      edits: [{ old_string: oldString, new_string: source }],
    },
    signal,
  );
}

/**
 * Resolve a dot path to an instance, as Luau.
 *
 * Two measured details:
 *  - services must go through `GetService` (direct `game[name]` indexing is not reliable);
 *  - children must be found with `FindFirstChild`, NOT `root[name]`: indexing an Instance with a
 *    name it does not own throws in Roblox, so a lookup of a *missing* path raised an error and the
 *    caller could not distinguish "gone" from "failed".
 */
function resolveLuau(path: string): string {
  const segments = path.split('.');
  // Luau table literal, NOT JSON: `["a","b"]` is a parse error ("Failed to parse command code").
  const segsLiteral = `{${segments.map((segment) => JSON.stringify(segment)).join(', ')}}`;
  return `local segs = ${segsLiteral}\n`
    + 'local ok, first = pcall(function() return game:GetService(segs[1]) end)\n'
    + 'local root = ok and first or game:FindFirstChild(segs[1])\n'
    + 'for i = 2, #segs do\n'
    + '  if root == nil then break end\n'
    + '  root = root:FindFirstChild(segs[i])\n'
    + 'end\n';
}

/**
 * Delete an instance by path. The official server has no delete tool, so this runs Luau that walks
 * the DataModel and calls `:Destroy()`.
 *
 * MEASURED LIVE: the first version returned `"deleted"` unconditionally, so a path that resolved to
 * nil reported success while nothing was removed — a cleanup step that silently left every probe
 * script behind. It now fails explicitly when the path is missing, and re-checks afterwards that the
 * instance is really gone.
 */
export async function deleteInstance(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) throw new Error('Studio không mở công cụ xoá để khôi phục.');
  // A legacy `studio.delete_instance` (fake gateway) takes the path directly — no Luau needed.
  if (tool.startsWith('studio.')) {
    const result = await mcp.callTool(tool, { path }, signal);
    return !isErrorText(result);
  }

  const destroy = `${resolveLuau(path)}if root == nil then return "error: not found" end\nroot:Destroy()\nreturn "ok"`;
  const result = await mcp.callTool(tool, { code: destroy, datamodel_type: DATAMODEL }, signal);
  if (isErrorText(result)) return false;

  // Verify: a destroy that threw inside pcall, or a name that reappeared, must not read as success.
  const probe = `${resolveLuau(path)}return root == nil and "missing" or "exists"`;
  const after = await mcp.callTool(tool, { code: probe, datamodel_type: DATAMODEL }, signal);
  return typeof after === 'string' && after.trim().toLowerCase() === 'missing';
}

/**
 * `callTool` returns normalised text, and a success answer is a string like `"deleted"`. An error
 * answer (when the gateway did not throw for a tool that reports failures as text) must not be read
 * as success, so the usual Luau failure prefixes are treated as failure.
 */
function isErrorText(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (typeof result !== 'string') return false;
  return /^\s*(error|failed|Luau error|attempt to index|stack traceback)/i.test(result);
}

/**
 * Which keys of an `inspect_instance` bag can actually be written back.
 *
 * MEASURED on a live `Part`: the bag had 36 keys and only 16 were writable. The serialisation is
 * lossy — `CFrame.Position`/`PivotOffset.Rotation` are flattened pseudo-paths ("not a valid member
 * of Part"), `Size`/`Color`/`Rotation` arrive as comma-joined strings ("Vector3 expected, got
 * string"), enums arrive as `"Enum.Material.Plastic"`, `BrickColor` arrives as `"Medium stone
 * grey"`, `Capabilities` arrives as `""` but wants a `SecurityCapabilities` object, and `UniqueId`
 * is capability-locked. Re-applying the raw bag threw on the first bad key and failed every
 * property restore.
 *
 * Strings are the crux and the reason this filter is blunt: the wire serialises most non-primitive
 * types INTO strings, so a writable string property (`CollisionGroup: "Default"`,
 * `MaterialVariant: ""`) is indistinguishable from a serialised one (`BrickColor: "Medium stone
 * grey"`, `Capabilities: ""`). No value test can separate them: every heuristic tried against the
 * live server (skip `Enum.*`, skip comma-numbers, skip known read-only names) still let one bad key
 * through. So only numbers and booleans are restored — they always round-trip.
 *
 * That deliberately gives up `CollisionGroup`/`MaterialVariant` rather than risk claiming a property
 * was restored when it was not. A property that survives the filter can still fail for a
 * machine-specific reason, which is why the restore engine re-inspects and verifies after writing.
 *
 * Note `Name` is not in the bag at all (it is the top-level `name` field), so renaming is not part of
 * a property restore.
 */
export function restorableProperties(bag: Record<string, unknown>): Record<string, unknown> {
  const restorable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (key.includes('.')) continue;
    if (typeof value === 'number' || typeof value === 'boolean') restorable[key] = value;
  }
  return restorable;
}

/**
 * Re-apply a property bag to an instance. There is no dedicated `set_properties` tool, and the real
 * server rejects arbitrary writes via `execute_luau` only for trusted contexts, so this is best
 * effort: it returns true when the capability ran, false when absent. Callers must re-inspect to
 * verify (the restore engine does that).
 */
export async function setInstanceProperties(
  mcp: McpGateway,
  path: string,
  properties: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const legacy = await pickTool(mcp, ['studio.set_properties', 'studio.update_properties'] as const, signal);
  if (legacy !== undefined) {
    const result = await mcp.callTool(legacy, { path, properties }, signal);
    return !isErrorText(result);
  }
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) throw new Error('Studio không mở công cụ đặt thuộc tính để khôi phục.');
  // `inst` must be bound before it is indexed — the previous version emitted `inst[key] = …` against
  // an undeclared local, so the Luau failed at runtime and every property restore reported failure.
  const assignments = Object.entries(properties)
    .map(([key, value]) => `  inst[${JSON.stringify(key)}] = ${JSON.stringify(value)}`)
    .join('\n');
  const code = `${resolveLuau(path)}if root == nil then return "error: not found" end\nlocal inst = root\n${assignments}\nreturn "ok"`;
  const result = await mcp.callTool(tool, { code, datamodel_type: DATAMODEL }, signal);
  return !isErrorText(result);
}
