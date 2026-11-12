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
 *
 * REAL vs LEGACY is decided by `speaksRealShape`, NOT by the name prefix: the app's own
 * `ServiceMcpGateway` publishes the real tools PREFIXED (`studio.script_read`), so a prefix means
 * nothing. The advertised schema is authoritative (real schemas carry `target_file` / `file_path` /
 * `code`); an unprefixed name is the raw server and is real by definition; a prefixed schema-less
 * entry can only be a legacy fake alias. The HTTP end-to-end caught this — the prefix heuristic
 * made every snapshot read fail through the app gateway while all fake-gateway tests stayed green.
 */

const SCRIPT_READ_CANDIDATES = ['script_read', 'studio.script_read', 'studio.read_script'] as const;
/** Legacy aliases (fake/E2E gateways) take `{ path, source }`; the real tool takes `file_path`+`edits`. */
const SCRIPT_WRITE_CANDIDATES = ['multi_edit', 'studio.multi_edit', 'studio.write_script', 'studio.edit_script', 'studio.create_script'] as const;
const INSPECT_CANDIDATES = ['inspect_instance', 'studio.inspect_instance'] as const;
const LUAU_CANDIDATES = ['execute_luau', 'studio.execute_luau'] as const;

const DATAMODEL = 'Edit';

/** One thing the mutation can be undone from. */
/**
 * One instance of a subtree captured BEFORE it is deleted, so the restore can recreate it.
 *
 * Only what the wire can round-trip is stored: the class name, the name, the restorable property
 * bag (see `restorableProperties`) and the children in order. A child's `path` is stored so the
 * recreate can parent it by path instead of re-deriving names, which would break on a name edit.
 */
export interface InstanceNode {
  path: string;
  className: string;
  name: string;
  properties: Record<string, unknown>;
  children: InstanceNode[];
}

export type SnapshotEntry =
  | { kind: 'script'; path: string; source: string }
  | { kind: 'properties'; path: string; properties: Record<string, unknown> }
  | { kind: 'inserted'; path: string }
  | { kind: 'deleted'; path: string; tree: InstanceNode };

export type InverseStep =
  | { tool: 'script_write'; path: string; source: string }
  | { tool: 'set_properties'; path: string; properties: Record<string, unknown> }
  | { tool: 'delete_instance'; path: string }
  | { tool: 'recreate_instance'; path: string; tree: InstanceNode };

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

/** The gateway entry worth its argument shape: name plus the schema the gateway advertises. */
interface PickedTool {
  name: string;
  parameters: { properties?: Record<string, unknown> } | undefined;
}

/**
 * Pick the first candidate the gateway actually exposes; undefined ⇒ the capability is absent.
 * The SCHEMA comes back too, because the real-vs-legacy decision below must be made from what the
 * tool actually accepts, not from its name (see `speaksRealShape`).
 */
async function pickTool(
  mcp: McpGateway,
  candidates: readonly string[],
  signal?: AbortSignal,
): Promise<PickedTool | undefined> {
  let listed: Array<{ name: string; parameters?: unknown }>;
  try {
    listed = await mcp.listTools();
  } catch {
    return undefined;
  }
  for (const candidate of candidates) {
    const tool = listed.find((entry) => entry.name === candidate);
    if (tool !== undefined) {
      return {
        name: tool.name,
        parameters: (tool.parameters ?? undefined) as PickedTool['parameters'],
      };
    }
  }
  return undefined;
}

/**
 * Does this gateway entry speak the REAL server's argument shape?
 *
 * MEASURED GOTCHA (found by the HTTP end-to-end, never by fakes): the app's own
 * `ServiceMcpGateway` publishes the real tools as `studio.script_read` / `studio.multi_edit` —
 * PREFIXED — while the raw server (and the live probe) uses `script_read` / `multi_edit`. A name
 * prefix therefore says nothing about which wire shape to speak. Two signals decide, strongest
 * first:
 *  1. the advertised schema carries the discriminating property (`target_file`, `file_path`,
 *     `code`) — the app gateway forwards real schemas, so this is authoritative;
 *  2. otherwise the name itself: the raw server's names are UNPREFIXED, so an unprefixed match is
 *     the real tool, while a prefixed schema-less match can only be a legacy fake alias.
 */
function speaksRealShape(tool: PickedTool, discriminatingProperty: string): boolean {
  if (tool.parameters?.properties?.[discriminatingProperty] !== undefined) return true;
  return !tool.name.startsWith('studio.');
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
  const args = speaksRealShape(tool, 'target_file')
    ? { target_file: path, should_read_entire_file: true }
    : { path };
  try {
    const result = await mcp.callTool(tool.name, args, signal);
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
    const result = await mcp.callTool(tool.name, { path }, signal);
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
  if (!speaksRealShape(tool, 'file_path')) return mcp.callTool(tool.name, { path, source }, signal);

  const current = await readScriptSource(mcp, path, signal);
  const exists = current !== null && current !== '';
  // An empty script is indistinguishable from a missing one here; appending onto nothing is exact.
  const oldString = exists ? current! : '';
  return mcp.callTool(
    tool.name,
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
function resolveLuau(path: string, suffix = ''): string {
  const segments = path.split('.');
  const segs = `segs${suffix}`;
  const root = `root${suffix}`;
  // Luau table literal, NOT JSON: `["a","b"]` is a parse error ("Failed to parse command code").
  const segsLiteral = `{${segments.map((segment) => JSON.stringify(segment)).join(', ')}}`;
  return `local ${segs} = ${segsLiteral}\n`
    + `local ok${suffix}, first${suffix} = pcall(function() return game:GetService(${segs}[1]) end)\n`
    + `local ${root} = ok${suffix} and first${suffix} or game:FindFirstChild(${segs}[1])\n`
    + `for i = 2, #${segs} do\n`
    + `  if ${root} == nil then break end\n`
    + `  ${root} = ${root}:FindFirstChild(${segs}[i])\n`
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
  // A dedicated delete tool (never shipped by the real server) would take the path directly.
  const dedicated = await pickTool(mcp, ['studio.delete_instance', 'studio.remove_instance'] as const, signal);
  if (dedicated !== undefined) {
    const result = await mcp.callTool(dedicated.name, { path }, signal);
    return !isErrorText(result);
  }
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) throw new Error('Studio không mở công cụ xoá để khôi phục.');

  const destroy = `${resolveLuau(path)}if root == nil then return "error: not found" end\nroot:Destroy()\nreturn "ok"`;
  const result = await mcp.callTool(tool.name, { code: destroy, datamodel_type: DATAMODEL }, signal);
  if (isErrorText(result)) return false;

  // Verify: a destroy that threw inside pcall, or a name that reappeared, must not read as success.
  const probe = `${resolveLuau(path)}return root == nil and "missing" or "exists"`;
  const after = await mcp.callTool(tool.name, { code: probe, datamodel_type: DATAMODEL }, signal);
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
 * A CFrame captured through Luau, because the property bag cannot carry one.
 *
 * MEASURED LIVE: `inspect_instance` flattens a CFrame into the pseudo-paths `CFrame.Position` and
 * `CFrame.Rotation`, which are not members of the instance at all ("not a valid member of Part"),
 * so moving a part used to be completely non-restorable — the single most common Studio edit. The
 * twelve components are read directly instead and written back as `CFrame.new(x, y, z, R00 … R21)`.
 *
 * The key is kept so a Model (which has `WorldPivot`, not `CFrame`) restores through the property it
 * actually owns. `position` is a copy of the first three components: drift detection compares it
 * against the bag's `CFrame.Position` string without re-deriving the matrix.
 */
export interface CapturedCframe {
  key: 'CFrame' | 'WorldPivot';
  components: number[];
  position: number[];
}

/** Marker that carries a captured CFrame through the property pipeline. */
export interface CframeValue {
  $cframe: { key: 'CFrame' | 'WorldPivot'; components: number[]; position: number[] };
}

/**
 * Identity of an instance: what it is CALLED and WHOM it hangs under.
 *
 * Neither is in the property bag at all (the tool reports `Name` as a top-level field and never
 * reports `Parent`), so without capturing them a rename or a reparent had no inverse while the
 * checkpoint still claimed `restorable` — the worst kind of gap: the undo looked complete.
 */
export interface CapturedIdentity {
  name: string;
  /** Dot path of the parent, or null at the DataModel root (a service has no restorable parent). */
  parentPath: string | null;
  cframe: CapturedCframe | null;
}

/** Marker for a captured name; a JSON string literal is all the restore needs. */
export interface NameValue {
  $name: string;
}

/** Marker for a captured parent path; the restore resolves it back to an instance. */
export interface ParentValue {
  $parent: string;
}

export function isNameValue(value: unknown): value is NameValue {
  if (value === null || typeof value !== 'object') return false;
  return typeof (value as { $name?: unknown }).$name === 'string';
}

export function isParentValue(value: unknown): value is ParentValue {
  if (value === null || typeof value !== 'object') return false;
  return typeof (value as { $parent?: unknown }).$parent === 'string';
}

function isCframeValue(value: unknown): value is CframeValue {
  if (value === null || typeof value !== 'object') return false;
  const marker = (value as { $cframe?: unknown }).$cframe;
  if (marker === null || typeof marker !== 'object') return false;
  const components = (marker as { components?: unknown }).components;
  return Array.isArray(components) && components.length === 12
    && components.every((part) => typeof part === 'number' && Number.isFinite(part));
}

/**
 * Which keys of an `inspect_instance` bag are CANDIDATES for a restore.
 *
 * MEASURED on a live `Part`: the bag had 36 keys and 20 could not be written back. The serialisation
 * is lossy — `CFrame.Position`/`PivotOffset.Rotation` are flattened pseudo-paths ("not a valid member
 * of Part"), `Size`/`Color`/`Rotation` arrive as comma-joined strings ("Vector3 expected, got
 * string"), enums arrive as `"Enum.Material.Plastic"`, `BrickColor` arrives as `"Medium stone
 * grey"`, `Capabilities` arrives as `""` but wants a `SecurityCapabilities` object, and `UniqueId`
 * is capability-locked.
 *
 * A value test can never separate a writable string (`CollisionGroup: "Default"`,
 * `MaterialVariant: ""`, `StringValue.Value`) from a serialised one (`BrickColor: "Medium stone
 * grey"`, `Capabilities: ""`) — every heuristic tried against the live server let one bad key
 * through. So the bag is no longer filtered by type: scalars are kept as CANDIDATES and
 * `setInstanceProperties` decides key by key, in isolation, recording what it could not apply.
 *
 * Only two kinds of key are rejected up front, because they can never be property assignments:
 *  - dotted keys (`CFrame.Position`) — pseudo-paths, not members. Position and rotation are restored
 *    from the separately captured `CFrame` marker instead (see `captureCframe`);
 *  - non-scalars (objects/arrays) — no literal to emit, except the CFrame marker above.
 *
 * Note `Name` is not in the bag at all (it is the top-level `name` field), so renaming is not part of
 * a property restore.
 */
export function restorableProperties(bag: Record<string, unknown>): Record<string, unknown> {
  const restorable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (key.includes('.')) continue;
    // Markers are checked BEFORE the deny list: `Parent` is denied as a scalar (a plain string there
    // fails with "Instance expected, got string"), but the captured-parent marker is exactly the form
    // the restore can apply.
    if (isCframeValue(value) || isNameValue(value) || isParentValue(value)) {
      restorable[key] = value;
      continue;
    }
    if (NEVER_WRITABLE.has(key)) continue;
    const type = typeof value;
    if (type === 'number' || type === 'boolean' || type === 'string') restorable[key] = value;
  }
  return restorable;
}

/**
 * Keys no restore can ever assign, whatever the value.
 *
 * MEASURED LIVE, each with Studio's own refusal: `UniqueId` — "The current thread cannot write
 * 'UniqueId' (lacking capability RobloxScript)"; `Capabilities` and `ExplorerIconContent` arrive as
 * an empty string but want an object (`SecurityCapabilities`/`Content`); `ClassName` and `Parent` are
 * structural and assigned by the recreate itself.
 *
 * `BrickColor` is here for a different reason, MEASURED LIVE too: it is a legacy MIRROR of `Color`,
 * and writing it fights the exact colour. A part restored from `Color = 200,40,90` came back as
 * `205,84,75` — Neon's own colour — because `BrickColor = "Neon"` was assigned afterwards and won.
 * Leaving it out lets `Color` (which round-trips exactly) stay the source of truth.
 *
 * They are dropped at capture time rather than at write time so the report stays honest: a `skipped`
 * entry must mean "this restore lost something", not "this bag always contains fields nobody can
 * write". A restore that lists them on every undo teaches the user to ignore the list.
 */
const NEVER_WRITABLE: ReadonlySet<string> = new Set([
  'ClassName',
  'Parent',
  'UniqueId',
  'Capabilities',
  'ExplorerIconContent',
  'RobloxLocked',
  'BrickColor',
]);

/**
 * Turn an `inspect_instance` string value into a Luau literal that re-applies, when the wire's
 * serialisation is recoverable. MEASURED on a live `Part`: `Size`/`Color`/`Position` arrive as
 * `"x, y, z"` (Vector3/Color3), `BrickColor` arrives as a name like `"Medium stone grey"`. Naively
 * assigning the string fails (`Vector3 expected, got string`). For those shapes we emit a real
 * constructor so the per-key `pcall` in `setInstanceProperties` succeeds; anything we cannot recover
 * is left as a plain JSON string, which the `pcall` will reject and the caller will record as skipped.
 *
 * Only comma-triples of numbers and dotted BrickColor names are reconstructed — both are unambiguous,
 * so a misparse cannot silently write a wrong value (it just fails the pcall and stays skipped).
 */
export function reconstructValue(value: unknown, key?: string): string {
  if (isNameValue(value)) return JSON.stringify(value.$name);
  if (isCframeValue(value)) {
    // Twelve components: position then the 3x3 rotation, which is exactly the shape
    // `CFrame.new(x, y, z, R00, R01, R02, R10, R11, R12, R20, R21, R22)` takes.
    return `CFrame.new(${value.$cframe.components.map((part) => String(part)).join(', ')})`;
  }
  if (typeof value === 'string') {
    // An enum arrives as the string `"Enum.Material.Plastic"`, which is ALREADY a valid Luau
    // expression — emitting it as a JSON string (the old behaviour) made every enum property fail
    // with `Invalid value "Enum.Material.Plastic"` and land in `skipped`. Both halves are checked
    // against the identifier shape first, so a value like `"Enum..."` cannot inject code.
    const enumItem = /^Enum\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(value);
    if (enumItem) {
      return `Enum.${enumItem[1]}.${enumItem[2]}`;
    }
    const triple = value.match(/^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (triple) {
      return `Vector3.new(${triple[1]}, ${triple[2]}, ${triple[3]})`;
    }
    // No string->BrickColor heuristic: `BrickColor` is now dropped at capture time (see
    // NEVER_WRITABLE), and guessing it for any other key turned plain string properties like
    // `MaterialVariant: "Wood Grain"` into a BrickColor the pcall then rejected.
  }
  return JSON.stringify(value);
}

/** Outcome of a property re-apply: what landed, and what this build refuses (with its own reason). */
export interface PropertyWriteResult {
  /** Keys the Luau actually assigned. Only these may be verified by the caller. */
  applied: string[];
  /** Keys that could not be assigned — `reason` is Studio's own message, never a paraphrase. */
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * Re-apply a property bag to an instance, ONE KEY AT A TIME.
 *
 * There is no dedicated `set_properties` tool, so this runs Luau. Each assignment happens inside its
 * own `pcall`: the bag is lossy (see `restorableProperties`), and an unconditional re-apply threw on
 * the first unassignable key — `CFrame.Rotation is not a valid member`, `Vector3 expected, got
 * string`, `Invalid value "Enum.Material.Plastic"`, `cannot write 'UniqueId'` — which failed the whole
 * restore and, worse, half-applied it with no report.
 *
 * Isolating each key means a build-specific refusal costs exactly that key, and the caller is told
 * which ones in Studio's own words. The report comes back through `HttpService:JSONEncode` so it is
 * parsed, not scraped out of prose.
 */
export async function setInstanceProperties(
  mcp: McpGateway,
  path: string,
  properties: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PropertyWriteResult> {
  const legacy = await pickTool(mcp, ['studio.set_properties', 'studio.update_properties'] as const, signal);
  if (legacy !== undefined) {
    const result = await mcp.callTool(legacy.name, { path, properties }, signal);
    // A dedicated tool is all-or-nothing: either every key went in or the call failed.
    if (isErrorText(result)) throw new Error(String(result));
    return { applied: Object.keys(properties), skipped: [] };
  }
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) throw new Error('Studio không mở công cụ đặt thuộc tính để khôi phục.');

  // `inst` must be bound before it is indexed — an earlier version emitted `inst[key] = …` against an
  // undeclared local, so the Luau failed at runtime and every property restore reported failure.
  // `reconstructValue` recovers Vector3/Color3/BrickColor literals from the lossy serialisation where
  // possible; any value it cannot recover stays a plain string, which the pcall rejects → skipped.
  const attempts = Object.entries(properties)
    .filter(([, value]) => !isParentValue(value))
    .map(([key, value]) => `attempt(${JSON.stringify(key)}, ${reconstructValue(value, key)})`)
    .join('\n');
  // `Parent` is the one key whose value is an INSTANCE, not a literal: it is resolved from the
  // recorded dot path and assigned separately. Passing the path as a string would fail every time
  // ("Instance expected, got string"), which is how a reparent used to be silently un-undoable.
  const parentMarker = properties.Parent;
  const parentLines = isParentValue(parentMarker)
    ? [
        resolveLuau(parentMarker.$parent, 'P'),
        'if rootP == nil then table.insert(failed, { key = "Parent", reason = "không tìm thấy đối tượng cha" })',
        'else',
        '  local okParent, errParent = pcall(function() inst.Parent = rootP end)',
        '  if okParent then table.insert(applied, "Parent")',
        '  else table.insert(failed, { key = "Parent", reason = tostring(errParent) }) end',
        'end',
      ].join('\n')
    : '';
  const code = [
    resolveLuau(path),
    'local inst = root',
    'if inst == nil then return "error: not found" end',
    'local applied, failed = {}, {}',
    // A comma-triple is ambiguous BY VALUE: `Size` is a Vector3 while `Color` is a Color3, and both
    // arrive as `"x, y, z"`. MEASURED LIVE: emitting Vector3 for `Color` was refused with "Color3
    // expected, got Vector3", so the colour of every restored part was silently lost. The retry uses
    // Studio's own refusal to disambiguate instead of guessing a second time.
    'local function attempt(key, value)',
    '  local ok, err = pcall(function() inst[key] = value end)',
    '  if not ok and typeof(value) == "Vector3" then',
    '    ok, err = pcall(function() inst[key] = Color3.new(value.X, value.Y, value.Z) end)',
    '  end',
    '  if ok then table.insert(applied, key)',
    '  else table.insert(failed, { key = key, reason = tostring(err) }) end',
    'end',
    // The name goes FIRST: a later step addresses this instance by its recorded path, and a rename in
    // the middle of the batch would make those lookups miss.
    attempts,
    parentLines,
    'return game:GetService("HttpService"):JSONEncode({ applied = applied, failed = failed })',
  ].join('\n');

  const result = await mcp.callTool(tool.name, { code, datamodel_type: DATAMODEL }, signal);
  const text = typeof result === 'string' ? result : '';
  if (isErrorText(result)) throw new Error(text || 'Studio báo lỗi khi đặt thuộc tính.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparsable means the report cannot be trusted: say so instead of assuming every key landed.
    throw new Error('Studio không trả về kết quả đọc được khi đặt thuộc tính.');
  }
  const record = (parsed ?? {}) as { applied?: unknown; failed?: unknown };
  const applied = Array.isArray(record.applied) ? record.applied.filter((key): key is string => typeof key === 'string') : [];
  const skipped = Array.isArray(record.failed)
    ? record.failed
      .filter((entry): entry is { key: unknown; reason?: unknown } => entry !== null && typeof entry === 'object')
      .map((entry) => ({ key: String((entry as { key?: unknown }).key ?? ''), reason: String((entry as { reason?: unknown }).reason ?? '') }))
    : [];
  return { applied, skipped };
}

/** How deep a captured subtree may go. A DeepSeek-sized tree would be thousands of bags. */
const TREE_MAX_NODES = 200;
const TREE_MAX_DEPTH = 4;

/** A node as Luau reports it: everything but the property bag, which comes from `inspect_instance`. */
export interface NodeOutline {
  path: string;
  className: string;
  name: string;
}

/**
 * Read the SHAPE of a subtree (paths, class names, names) without its properties.
 *
 * Deliberately not `inspect_instance` per node: that tool takes one path per call, so a subtree
 * would cost a round trip per descendant. Luau walks the subtree once and reports only what the
 * engine knows exactly (`ClassName`, `Name`) — the lossy property serialisation stays in the tool
 * that was measured for it.
 *
 * Returns `null` when the path does not resolve: a missing instance must not become an empty tree,
 * which would restore as "nothing to do" and silently lose the delete.
 */
export async function captureSubtree(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<NodeOutline[] | null> {
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) return null;

  const code = [
    resolveLuau(path),
    'if root == nil then return "error: not found" end',
    'local nodes = {}',
    'local function walk(inst, nodePath, depth)',
    '  if #nodes >= ' + String(TREE_MAX_NODES) + ' then return end',
    '  table.insert(nodes, { path = nodePath, className = inst.ClassName, name = inst.Name })',
    '  if depth >= ' + String(TREE_MAX_DEPTH) + ' then return end',
    // Only `Name` identifies a child on the wire (see resolveLuau); a duplicate name is reported
    // twice rather than merged, and the recreate then assigns in order.
    '  for _, child in ipairs(inst:GetChildren()) do',
    '    walk(child, nodePath .. "." .. child.Name, depth + 1)',
    '  end',
    'end',
    'walk(root, ' + JSON.stringify(path) + ', 0)',
    'return game:GetService("HttpService"):JSONEncode({ nodes = nodes })',
  ].join('\n');

  const result = await mcp.callTool(tool.name, { code, datamodel_type: DATAMODEL }, signal);
  if (isErrorText(result) || typeof result !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const nodes = (parsed as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  return nodes
    .filter((node): node is Record<string, unknown> => node !== null && typeof node === 'object')
    .map((node) => ({
      path: String(node.path ?? ''),
      className: String(node.className ?? ''),
      name: String(node.name ?? ''),
    }))
    .filter((node) => node.path !== '' && node.className !== '');
}

/**
 * Capture a subtree that is about to be deleted, with the property bag of every node.
 *
 * Bounded (TREE_MAX_NODES / TREE_MAX_DEPTH): beyond that the tree is dropped entirely rather than
 * stored half-way, because a partial tree would recreate a mutilated instance and call it restored.
 */
export async function captureInstanceTree(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<InstanceNode | null> {
  const outline = await captureSubtree(mcp, path, signal);
  if (outline === null) return null;
  if (outline.length === 1 && outline[0].path !== path) return null;

  const nodes = new Map<string, InstanceNode>();
  for (const node of outline) {
    const bag = await inspectInstance(mcp, node.path, signal);
    // A node whose bag cannot be read is stored WITHOUT properties but with its shape: the class
    // and the children are what makes the recreate possible at all, and the restore reports the
    // property gap through `skipped` rather than dropping the whole subtree.
    nodes.set(node.path, {
      path: node.path,
      className: node.className,
      name: node.name,
      properties: bag === null ? {} : restorableProperties(bag),
      children: [],
    });
  }

  const root = nodes.get(path);
  if (root === undefined) return null;
  for (const node of nodes.values()) {
    if (node.path === path) continue;
    const parentPath = node.path.slice(0, node.path.lastIndexOf('.'));
    nodes.get(parentPath)?.children.push(node);
  }
  return root;
}

export interface RecreateResult {
  created: string[];
  skipped: Array<{ path: string; key: string; reason: string }>;
}

/**
 * Recreate a captured subtree under its original parent.
 *
 * Parent FIRST, children in recorded order: a child can only be parented to an instance that
 * already exists. Each node is one Luau call, so a single refused class (a plugin-owned type, a
 * locked service) costs that node instead of the whole undo — the caller reports what it could not
 * recreate rather than claiming a clean restore.
 */
export async function recreateInstance(
  mcp: McpGateway,
  path: string,
  tree: InstanceNode,
  signal?: AbortSignal,
): Promise<RecreateResult> {
  const created: string[] = [];
  const skipped: RecreateResult['skipped'] = [];

  const ordered: InstanceNode[] = [];
  const queue: InstanceNode[] = [tree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    ordered.push(node);
    queue.push(...node.children);
  }

  for (const node of ordered) {
    const parentPath = node.path.includes('.') ? node.path.slice(0, node.path.lastIndexOf('.')) : '';
    if (parentPath === '') {
      skipped.push({ path: node.path, key: 'Parent', reason: 'Không xác định được đối tượng cha để tạo lại.' });
      continue;
    }
    const props = Object.entries(node.properties)
      .filter(([key]) => key !== 'ClassName' && key !== 'Parent')
      .map(([key, value]) => `attempt(${JSON.stringify(key)}, ${reconstructValue(value, key)})`)
      .join('\n');
    const code = [
      resolveLuau(parentPath),
      'if root == nil then return "error: parent not found" end',
      `local ok, inst = pcall(Instance.new, ${JSON.stringify(node.className)})`,
      'if not ok or inst == nil then return "error: cannot create " .. ' + JSON.stringify(node.className) + ' end',
      `inst.Name = ${JSON.stringify(node.name)}`,
      'local failed = {}',
      'local function attempt(key, value)',
      '  local applied, err = pcall(function() inst[key] = value end)',
      // Same Vector3/Color3 ambiguity as `setInstanceProperties`; see the note there.
      '  if not applied and typeof(value) == "Vector3" then',
      '    applied, err = pcall(function() inst[key] = Color3.new(value.X, value.Y, value.Z) end)',
      '  end',
      '  if not applied then table.insert(failed, { key = key, reason = tostring(err) }) end',
      'end',
      props,
      'inst.Parent = root',
      'return game:GetService("HttpService"):JSONEncode({ ok = true, failed = failed })',
    ].join('\n');

    const result = await mcp.callTool(await luauToolName(mcp, signal), { code, datamodel_type: DATAMODEL }, signal);
    if (isErrorText(result) || typeof result !== 'string') {
      skipped.push({ path: node.path, key: 'ClassName', reason: String(result ?? '').slice(0, 200) });
      continue;
    }
    created.push(node.path);
    try {
      const parsed = JSON.parse(result) as { failed?: unknown };
      if (Array.isArray(parsed.failed)) {
        for (const entry of parsed.failed) {
          if (entry === null || typeof entry !== 'object') continue;
          skipped.push({
            path: node.path,
            key: String((entry as { key?: unknown }).key ?? ''),
            reason: String((entry as { reason?: unknown }).reason ?? ''),
          });
        }
      }
    } catch {
      // The node was created; only its property report is unreadable.
    }
  }

  return { created, skipped };
}

/** The Luau tool name, or a literal that fails loudly when Studio has none. */
async function luauToolName(mcp: McpGateway, signal?: AbortSignal): Promise<string> {
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) throw new Error('Studio không mở công cụ Luau để khôi phục.');
  return tool.name;
}

/**
 * Does this path still resolve? `null` means the probe itself failed, which is NOT "missing" — a
 * restore that reads a failed probe as "gone" would recreate an instance over a live one.
 */
export async function instanceExists(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) return null;
  const code = [
    resolveLuau(path),
    'if root == nil then return "missing" end',
    'return "exists"',
  ].join('\n');
  const result = await mcp.callTool(tool.name, { code, datamodel_type: DATAMODEL }, signal);
  if (isErrorText(result) || typeof result !== 'string') return null;
  const answer = result.trim().toLowerCase();
  if (answer === 'missing') return false;
  if (answer === 'exists') return true;
  return null;
}

/**
 * Read the instance's CFrame (or a Model's `WorldPivot`) through Luau.
 *
 * Returns null when the instance owns neither — a `Script`, a `Folder` or a `ScreenGui` has no
 * transform, and inventing one would make the restore write a member that does not exist. A failed
 * Luau read is null too: "cannot read" must never become "no transform to restore".
 */
export async function captureIdentity(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<CapturedIdentity | null> {
  const tool = await pickTool(mcp, LUAU_CANDIDATES, signal);
  if (tool === undefined) return null;

  // One round trip for all three: the name, the parent path and the transform. A call per property
  // would cost three MCP round trips on every mutating tool call, and the transform is not in the bag
  // at all. `GetComponents` is the only exact form — `cf.Position` alone would lose the rotation,
  // which is the half of a move a user notices first (a part turned 90° looks like a different part).
  const code = [
    resolveLuau(path),
    'if root == nil then return "none" end',
    'local info = { name = root.Name }',
    'local parent = root.Parent',
    'if parent ~= nil and parent ~= game then info.parentPath = parent:GetFullName() end',
    'local function comps(cf)',
    '  local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cf:GetComponents()',
    '  return { x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 }',
    'end',
    'local okCf, cf = pcall(function() return root.CFrame end)',
    'if okCf and typeof(cf) == "CFrame" then',
    '  info.key = "CFrame"',
    '  info.components = comps(cf)',
    'else',
    '  local okWp, wp = pcall(function() return root.WorldPivot end)',
    '  if okWp and typeof(wp) == "CFrame" then',
    '    info.key = "WorldPivot"',
    '    info.components = comps(wp)',
    '  end',
    'end',
    'return game:GetService("HttpService"):JSONEncode(info)',
  ].join('\n');

  const result = await mcp.callTool(tool.name, { code, datamodel_type: DATAMODEL }, signal);
  if (isErrorText(result) || typeof result !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const record = (parsed ?? {}) as { name?: unknown; parentPath?: unknown; key?: unknown; components?: unknown };
  if (typeof record.name !== 'string') return null;

  let cframe: CapturedCframe | null = null;
  const key = record.key;
  const components = record.components;
  if ((key === 'CFrame' || key === 'WorldPivot') && Array.isArray(components) && components.length === 12) {
    const numbers = components.map((value) => (typeof value === 'number' ? value : Number(value)));
    if (!numbers.some((value) => !Number.isFinite(value))) {
      cframe = { key, components: numbers, position: numbers.slice(0, 3) };
    }
  }
  const parentPath = typeof record.parentPath === 'string' && record.parentPath !== '' ? record.parentPath : null;
  return { name: record.name, parentPath, cframe };
}

/** Just the transform, when that is all the caller needs (drift and verification read the identity). */
export async function captureCframe(
  mcp: McpGateway,
  path: string,
  signal?: AbortSignal,
): Promise<CapturedCframe | null> {
  return (await captureIdentity(mcp, path, signal))?.cframe ?? null;
}

/** Markers for the identity, so it flows through the same property pipeline as the scalars. */
export function identityMarkers(identity: CapturedIdentity): Record<string, unknown> {
  const markers: Record<string, unknown> = { Name: { $name: identity.name } };
  if (identity.parentPath !== null) markers.Parent = { $parent: identity.parentPath };
  if (identity.cframe !== null) markers[identity.cframe.key] = cframeMarker(identity.cframe);
  return markers;
}

/** Compare stored identity markers with a freshly captured identity (tolerance only for the transform). */
export function sameIdentity(name: unknown, parent: unknown, live: CapturedIdentity | null): boolean {
  if (live === null) return false;
  if (isNameValue(name) && name.$name !== live.name) return false;
  if (isParentValue(parent) && parent.$parent !== (live.parentPath ?? '')) return false;
  return true;
}

/** A captured CFrame as it is stored in a property bag (marker, so it survives JSON round-trips). */
export function cframeMarker(captured: CapturedCframe): CframeValue {
  return { $cframe: { key: captured.key, components: captured.components, position: captured.position } };
}

/**
 * Compare a stored CFrame marker with a freshly captured one.
 *
 * Rotation is compared as a MATRIX, not as Euler angles: `Orientation` is derived and would disagree
 * on the gimbal edge (90° about X), which is a normal orientation for a part.
 */
export function sameCframe(stored: CframeValue | CapturedCframe | undefined, live: CapturedCframe | null): boolean {
  if (stored === undefined || live === null) return false;
  const left = '$cframe' in stored ? stored.$cframe : stored;
  if (left.key !== live.key) return false;
  return left.components.every((value, index) => Math.abs(value - live.components[index]) < 1e-4);
}

/** Is this stored property value a captured CFrame marker? */
export function isCframeMarkerValue(value: unknown): value is CframeValue {
  return isCframeValue(value);
}
