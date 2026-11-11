import type { ToolSchema } from './types';

/**
 * Tool calling over a web chat that has NO native tool API.
 *
 * Ported from github.com/AppsGanin/ai-free-vscode (MIT), which proved the approach live on
 * DeepSeek/Qwen/Kimi: the tools are described in a system prompt, the model prints the call into the
 * answer in one of several dialects it was trained on, and a streaming router spots the marker with a
 * sliding window, holds the candidate until the call is complete, parses it, and never lets the raw
 * protocol reach the user.
 *
 * Why so many dialects: DeepSeek falls back to whatever its training data favours no matter what the
 * prompt asks for — the fenced form, `CallableWrapper`, Anthropic-style `<invoke>` XML (sometimes
 * behind its own `<｜｜DSML｜｜…>` marker built from fullwidth bars), `<tool_name>/<tool_arguments>`
 * pairs, and plain JSON. They are parsed rather than fought.
 */

/** One routed piece of the answer stream. */
export type ToolCallChunk =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; callId: string; name: string; argumentsPart: string };

/** Morphi's tool catalogue, as the protocol prompt needs it. */
export interface PromptTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: unknown };
}

const TOOL_CALL_MARKERS = [
  '```tool_call',
  // Bare `CallableWrapper` and the attribute form `<tool_call name="…">`.
  '<tool_call',
  '`tool_call {',
  'tool_call {',
  '\ntool_call {',
  // MiMo/Qwen-Coder native XML: <function=name><parameter=key>…
  '<function=',
  // MiMo variant: <tool_name>name</tool_name><tool_arguments>{…}
  '<tool_name>',
  // Anthropic-style XML, which DeepSeek reproduces from its training data:
  // <function_calls><invoke name="read_file"><parameter name="path">…
  '<function_calls>',
  '<invoke',
];

// Shortest partial marker prefix we accept, so a plain ``` fence is not held.
const MIN_PARTIAL_MARKER_LEN = 6;

// Start of a bare JSON tool call: {"name": / {"tool": "…"
const JSON_START_RE = /\{\s*"(?:name|tool)"\s*:/;
// Start of a wrapper object the model invented: {"tool_call": {…
const ENVELOPE_START_RE = /\{\s*"(?:tool_call|tool_calls|tool_use|function_call)"\s*:/i;
// Partial tail: `{`, `{\n`, `{ "`, `{"na`, … deltas regularly break right after `{`.
const JSON_PARTIAL_TAIL_RE = /\{\s*(?:"(?:n(?:a(?:m(?:e)?)?)?)?)?$/;

// A fence the model opened immediately before the call (```json\n{"tool_call"…).
// Only a fence carrying a language tag: a bare ``` is ambiguous — it may be
// closing an earlier block, and swallowing it breaks that block's rendering.
const FENCE_OPENER_TAIL_RE = /(^|\n)[ \t]*```[a-zA-Z0-9_-]+[ \t]*\r?\n[ \t]*$/;

/**
 * Index where the first tool-call marker starts — full, or partial at the end
 * of the buffer (markers get split across SSE chunks). -1 when there is none.
 */
export function findToolCallMarkerStart(text: string): number {
  let earliest = -1;
  const take = (index: number): void => {
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index;
  };

  for (const marker of TOOL_CALL_MARKERS) {
    take(text.indexOf(marker));
    for (let len = Math.min(marker.length - 1, text.length); len >= MIN_PARTIAL_MARKER_LEN; len -= 1) {
      if (text.endsWith(marker.slice(0, len))) {
        take(text.length - len);
        break;
      }
    }
  }

  // Same dialect carrying a namespace prefix (`<ns:invoke …>`), which no literal above can match.
  take(INVOKE_MARKER_RE.exec(text)?.index ?? -1);
  take(NS_PARTIAL_TAIL_RE.exec(text)?.index ?? -1);
  take(JSON_START_RE.exec(text)?.index ?? -1);
  take(ENVELOPE_START_RE.exec(text)?.index ?? -1);
  take(JSON_PARTIAL_TAIL_RE.exec(text)?.index ?? -1);
  return earliest === -1 ? -1 : expandMarkerStart(text, earliest);
}

/**
 * Widens the marker to the wrapper the call sits in.
 *
 * Models regularly bury the call in an object of their own (`{"tool_call": {"name":…}}`) or open a
 * fenced block for it. The marker is then found at the inner `{`, and everything in front of it —
 * ```` ```json ````, `{`, `"tool_call":` — has already been streamed out by the time the call is
 * recognised. That leftover is what the user would see as a stray JSON block.
 */
function expandMarkerStart(text: string, markerIdx: number): number {
  let start = markerIdx;

  // `{`, `{ "tool_call": `, `{"result": {"tool_call": ` — bounded, so a marker deep inside real
  // prose cannot drag the whole answer into the hold.
  for (let depth = 0; depth < 4; depth += 1) {
    let i = skipSpaceBack(text, start - 1);
    if (i >= 0 && text[i] === ':') {
      i = skipSpaceBack(text, i - 1);
      if (i < 0 || text[i] !== '"') break;
      const keyEnd = i;
      i -= 1;
      while (i >= 0 && /[\w.$-]/.test(text[i] ?? '')) i -= 1;
      if (i < 0 || text[i] !== '"' || keyEnd - i < 2) break;
      i = skipSpaceBack(text, i - 1);
    }
    if (i < 0 || text[i] !== '{') break;
    start = i;
  }

  const fence = FENCE_OPENER_TAIL_RE.exec(text.slice(0, start));
  if (fence) start = (fence.index ?? 0) + (fence[1] ? 1 : 0);
  return start;
}

function skipSpaceBack(text: string, from: number): number {
  let i = from;
  while (i >= 0 && /\s/.test(text[i] ?? '')) i -= 1;
  return i;
}

/**
 * Does the buffer look like a real call rather than a false marker hit (a markdown fence)? Keeps
 * large legitimate calls held instead of flushed.
 */
export function looksLikeToolCallStart(text: string): boolean {
  return (
    /```tool_call|<tool_call|<function\s*=|<tool_name>/i.test(text)
    || INVOKE_PROTOCOL_RE.test(text)
    || /"(?:tool_call|tool_calls|tool_use|function_call)"\s*:/i.test(text)
    || /"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(text)
    || /"(?:arguments|parameters|params|input|args)"\s*:\s*\{/.test(text)
  );
}

/** Strips the wrapped forms of a tool call: fenced, tagged and bare JSON. */
export function stripToolCallBlocks(text: string): string {
  return stripInlineToolCallJson(
    text
      .replace(/```tool_call[\s\S]*?```/gi, '\n\n')
      .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '\n\n'),
  );
}

/**
 * Removes balanced `{"name":…,"arguments":{…}}` objects. A regex cannot do this:
 * `\{[\s\S]*?\}` breaks on `}` inside string values and leaves JSON in the chat.
 */
export function stripInlineToolCallJson(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const extracted = extractBalancedJsonAt(text, i);
      // Unanchored on purpose: this runs on ordinary answer text, where a JSON object without an
      // arguments field is data the user asked to see.
      if (extracted && callsFromJsonText(extracted.json, false).length > 0) {
        i = extracted.end;
        continue;
      }
    }
    result += text[i] ?? '';
    i += 1;
  }
  return result;
}

/** System prompt that pushes web models towards our tool-call syntax. */
export function buildToolsSystemPrompt(tools: readonly ToolSchema[]): string {
  const compactTools = tools.map((tool) => {
    const params = tool.parameters as { properties?: Record<string, unknown>; required?: unknown };
    const entries = Object.entries(params?.properties ?? {}).slice(0, 8);
    const types = Object.fromEntries(
      entries.flatMap(([key, schema]) => {
        const type = argType(schema);
        return type === undefined ? [] : [[key, type] as const];
      }),
    );
    return {
      name: tool.name,
      args: entries.map(([key]) => key),
      ...(Object.keys(types).length > 0 ? { types } : {}),
      required: Array.isArray(params?.required) ? (params!.required as unknown[]).slice(0, 8) : [],
      description: tool.description.slice(0, 120),
    };
  });

  return [
    '# Tool usage protocol (MANDATORY)',
    '',
    'Always answer in the same language as the user\'s latest message.',
    'Never switch language unless the user explicitly asks.',
    '',
    'If the user asks to inspect files/folders, read project state, run checks, or gather info, you MUST call a tool first.',
    'Do not explain a plan before the tool call.',
    'Do NOT output markdown links to local files instead of tool calls.',
    '',
    'When a tool is needed, output ONLY one fenced block in this exact format:',
    '```tool_call',
    '{"name":"tool_name","arguments":{"param":"value"}}',
    '```',
    '',
    'Alternative accepted format (fallback only):',
    '<tool_' + 'call>{"name":"tool_name","arguments":{...}}</tool_' + 'call>',
    '',
    'The object has exactly two keys — `name` and `arguments`:',
    '- Every parameter goes INSIDE `arguments`. Never next to `name`: {"name":"read_file","filePath":"…"} is wrong.',
    '- Never wrap the object in another one: {"tool_call":{…}} and {"function":{…}} are wrong.',
    '- Never use XML/Anthropic call syntax: <invoke name="…">, <parameter name="…"> and <function_calls> are wrong.',
    '',
    'JSON validity is CRITICAL — a malformed call is dropped:',
    '- Every string value MUST be valid JSON: escape " as \\", newlines as \\n, backslashes as \\\\, tabs as \\t.',
    '- Close every brace and quote. The object must be complete and balanced.',
    '- Output NOTHING after the closing ``` — no markdown, no links, no commentary.',
    '- When passing file contents (oldString/newString/code), escape them as a single JSON string; do not paste raw multi-line text.',
    '',
    'Rules:',
    '- Call tools one at a time.',
    '- Include ALL required arguments.',
    '- After tool result, continue with either next tool_call or final answer.',
    '- Never output pseudo tool syntax mixed with prose.',
    '',
    'After tool result is returned, continue normally.',
    '',
    '`types` gives the JSON type of every argument that is not a string; arguments not listed there are strings.',
    '`x[]` means a JSON array — e.g. "view_range":[1,180], never "1-180" or "1:180".',
    '',
    'Available tools (compact):',
    JSON.stringify(compactTools, null, 2),
  ].join('\n');
}

/**
 * JSON type of an argument for the prompt (`integer[]`, `boolean`, …), or undefined for strings.
 * Without it the model guesses, and writes ranges as "1-180" where the tool takes [1, 180].
 * Strings are left out to keep the prompt small, and the types sit apart from `args` so a name is
 * never mistaken for `name:type`.
 */
function argType(schema: unknown): string | undefined {
  const type = jsonType(schema);
  if (type === undefined || type === 'string') return undefined;
  if (type === 'array') {
    const items = jsonType((schema as { items?: unknown }).items);
    return `${items ?? 'any'}[]`;
  }
  return type;
}

/** First concrete type of a schema, through `["string","null"]` unions. */
function jsonType(schema: unknown): string | undefined {
  const type = (schema as { type?: unknown } | undefined)?.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((entry): entry is string => typeof entry === 'string' && entry !== 'null');
  return undefined;
}

const PARSERS: Array<{ label: string; parse: (text: string) => ToolCallChunk[] }> = [
  { label: 'invoke tag', parse: parseInvokeTagCalls },
  { label: 'tool_call attribute', parse: parseAttributeTagCalls },
  { label: 'xml function', parse: parseXmlFunctionCalls },
  { label: 'tool_name/tool_arguments', parse: parseTagPairCalls },
  // Last of the XML dialects: it is the only one without a distinguishing
  // attribute or `=`, so the more explicit ones get to claim the text first.
  { label: 'tool_call tag', parse: parseToolCallTagCalls },
  { label: 'fenced', parse: parseCodeFenceCalls },
  { label: 'bracket', parse: parseBracketCalls },
  { label: 'plain', parse: parsePlainCalls },
  { label: 'json', parse: parseJsonInlineCalls },
  { label: 'loose json', parse: parseLooseJsonCalls },
  { label: 'name+arguments', parse: parseNameArgumentsCalls },
  { label: 'repaired json', parse: parseRepairedJsonCalls },
  { label: 'prefixed', parse: parsePrefixedCalls },
];

/** `studio.multi_edit, studio.read_file×3` — compact call list for the logs. */
export function summarizeToolCalls(chunks: readonly ToolCallChunk[]): string {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    if (chunk.type !== 'tool_call') continue;
    const name = chunk.name || '(unnamed)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    [...counts]
      .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
      .join(', ') || '(none)'
  );
}

export interface ToolCallParseOptions {
  logger?: (message: string) => void;
  logPrefix?: string;
}

/** Parses accumulated response text into tool calls, or yields it as text. */
export function* parseToolCallsFromText(
  text: string,
  options?: ToolCallParseOptions,
): Iterable<ToolCallChunk> {
  const log = (calls: ToolCallChunk[], label: string) =>
    options?.logger?.(
      `${options.logPrefix ?? ''}parsed ${calls.length} tool_call(s) from ${label} syntax: ${summarizeToolCalls(calls)}`,
    );

  const tagged = parseTaggedCalls(text);
  const taggedCalls = withoutPlaceholders(tagged.calls, options);
  if (taggedCalls.length > 0) {
    log(taggedCalls, 'tagged');
    yield* taggedCalls;
    return;
  }

  for (const { label, parse } of PARSERS) {
    const calls = withoutPlaceholders(parse(text), options);
    if (calls.length === 0) continue;
    log(calls, label);
    yield* calls;
    return;
  }

  if (tagged.text.trim()) {
    yield { type: 'text', content: tagged.text.trimEnd() };
  }
}

/**
 * Drops the format example from our own system prompt
 * (`{"name":"tool_name","arguments":{"param":"value"}}`). Long-context models
 * echo it back verbatim, and it used to reach the client as a call to a tool
 * named `tool_name`.
 */
function withoutPlaceholders(
  calls: ToolCallChunk[],
  options?: ToolCallParseOptions,
): ToolCallChunk[] {
  return calls.filter((call) => {
    const placeholder = call.type === 'tool_call' && call.name === 'tool_name';
    if (placeholder) {
      options?.logger?.(
        `${options.logPrefix ?? ''}ignored the protocol example echoed as a call`,
      );
    }
    return !placeholder;
  });
}

/** `<tool_call …>` tag pairs; unparsable ones stay as text. */
function parseTaggedCalls(text: string): {
  calls: ToolCallChunk[];
  text: string;
} {
  // The complete opening and closing tags, angle brackets included.
  const OPEN = '<tool_' + 'call>';
  const CLOSE = '</tool_' + 'call>';
  const calls: ToolCallChunk[] = [];
  let buffered = '';
  let pos = 0;

  const keep = (raw: string) => {
    const trimmed = raw.trimEnd();
    if (trimmed) buffered += (buffered ? '\n' : '') + trimmed;
  };

  while (pos < text.length) {
    const openIdx = text.indexOf(OPEN, pos);
    if (openIdx === -1) {
      keep(text.slice(pos));
      break;
    }
    keep(text.slice(pos, openIdx));

    const closeIdx = text.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      keep(text.slice(openIdx));
      break;
    }

    const parsed = callsFromJsonText(
      text.slice(openIdx + OPEN.length, closeIdx).trim(),
      true,
    );
    if (parsed.length > 0) {
      calls.push(...toChunks(parsed));
    } else {
      keep(text.slice(openIdx, closeIdx + CLOSE.length));
    }
    pos = closeIdx + CLOSE.length;
  }

  return { calls, text: buffered };
}

// The name lives in an attribute and the arguments follow as a bare object:
//   <tool_call name="get_errors">{"filePaths": []}</tool_call…>
// The closing tag is optional — models drop it constantly.
const ATTRIBUTE_TAG_RE =
  /<tool_call\s+name\s*=\s*["']?([\w.:-]+)["']?\s*>([\s\S]*?)(?=<\/tool_call>|<tool_call\b|$)/gi;

function parseAttributeTagCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  for (const match of text.matchAll(ATTRIBUTE_TAG_RE)) {
    const name = match[1]?.trim();
    if (name) {
      calls.push(
        createToolCallChunk({
          name,
          argumentsValue: parseArgumentsBlock(match[2] ?? ''),
        }),
      );
    }
  }
  return calls;
}

function parseCodeFenceCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  for (const match of text.matchAll(/```tool_call\s*([\s\S]*?)```/g)) {
    // The fence declares protocol, so a flat `{"name":…,"filePath":…}` counts.
    calls.push(...toChunks(callsFromJsonText((match[1] ?? '').trim(), true)));
  }
  return calls;
}

function parseJsonInlineCalls(text: string): ToolCallChunk[] {
  const pattern =
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  const calls: ToolCallChunk[] = [];

  for (const match of text.matchAll(pattern)) {
    const name = (match[1] ?? '').trim();
    // Only well-formed arguments: the lazy `\{[\s\S]*?\}` often stops at a `}`
    // inside a value. A truncated capture is left to the repair fallbacks.
    const args = asObject(tryParseJson(match[2] ?? ''));
    if (name && args) {
      calls.push(createToolCallChunk({ name, argumentsValue: args }));
    }
  }

  return calls;
}

function parseLooseJsonCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];

  for (const raw of extractBalancedJsonObjects(text)) {
    // Unanchored: a plain object with a "name" but no arguments is data.
    calls.push(...toChunks(callsFromJsonText(raw, false)));
  }

  return calls;
}

/**
 * Pulls `name` and the balanced arguments object separately. Saves calls whose
 * outer `{"name":…}` wrapper is broken while the arguments themselves are valid.
 */
function parseNameArgumentsCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  const nameRe = /"name"\s*:\s*"([^"]+)"/g;

  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(text)) !== null) {
    const name = (m[1] ?? '').trim();
    if (!name) continue;

    const argsKeyRe = /"(?:arguments|params|input)"\s*:\s*\{/g;
    argsKeyRe.lastIndex = m.index + m[0].length;
    const am = argsKeyRe.exec(text);
    if (!am) continue;

    const extracted = extractBalancedJsonAt(text, am.index + am[0].length - 1);
    if (!extracted) continue;

    const args = asObject(tryParseJson(extracted.json));
    if (!args || Object.keys(args).length === 0) continue;

    calls.push(createToolCallChunk({ name, argumentsValue: args }));
    nameRe.lastIndex = extracted.end;
  }

  return calls;
}

function parseRepairedJsonCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  const startPattern = /\{\s*"name"\s*:/g;

  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(text)) !== null) {
    const repaired = repairToolCallJson(text, match.index);
    const parsed = repaired ? tryParseJson(repaired) : undefined;
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const args = parsed ? asObject(argumentsOf(parsed)) : undefined;

    // Empty/broken arguments are dropped: a bogus call can be destructive.
    if (name && args && Object.keys(args).length > 0) {
      calls.push(createToolCallChunk({ name, argumentsValue: args }));
      startPattern.lastIndex = match.index + (repaired as string).length;
    }
  }

  return calls;
}

function parsePrefixedCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const prefixIdx = text.indexOf('tool_call', searchFrom);
    if (prefixIdx === -1) break;

    const objStart = text.indexOf('{', prefixIdx);
    if (objStart === -1) break;

    const extracted = extractBalancedJsonAt(text, objStart);
    if (!extracted) break;

    // The literal `tool_call` in front of the object is the anchor.
    calls.push(...toChunks(callsFromJsonText(extracted.json, true)));
    searchFrom = extracted.end;
  }

  return calls;
}

function parseBracketCalls(text: string): ToolCallChunk[] {
  return callsFromPattern(text, /\[([a-zA-Z_][\w]*)\(([^\]]*)\)\]/g, 1, 2);
}

function parsePlainCalls(text: string): ToolCallChunk[] {
  return callsFromPattern(
    text,
    /(^|\s)([a-zA-Z_][\w]*)\(([^\n)]*)\)(?=\s|$)/gm,
    2,
    3,
  );
}

/** `tool(key="value")` style pseudo-calls, with or without brackets. */
function callsFromPattern(
  text: string,
  pattern: RegExp,
  nameGroup: number,
  argsGroup: number,
): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  for (const match of text.matchAll(pattern)) {
    const name = match[nameGroup]?.trim();
    if (!name) continue;
    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: parseKeyValueArgs(match[argsGroup] ?? ''),
      }),
    );
  }
  return calls;
}

// MiMo/Qwen-Coder native markup:
//   <function=read_file><parameter=path>/a/b.ts</parameter></function>
// Closing tags are frequently dropped, so both are optional: a block runs to the
// next tag or to the end.
const XML_FUNCTION_RE =
  /<function\s*=\s*([\w.:-]+)\s*>([\s\S]*?)(?=<\/function>|<function\s*=|<\/tool_call>|$)/gi;
const XML_PARAMETER_RE =
  /<parameter\s*=\s*([\w.:-]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter\s*=|<\/function>|<\/tool_call>|$)/gi;

function parseXmlFunctionCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  for (const match of text.matchAll(XML_FUNCTION_RE)) {
    const name = match[1]?.trim();
    if (name) {
      calls.push(
        createToolCallChunk({
          name,
          argumentsValue: parseXmlParameters(match[2] ?? ''),
        }),
      );
    }
  }
  return calls;
}

// Anthropic-style XML: a name attribute on `<invoke>`, one tag per parameter,
// optionally wrapped in `<function_calls>` and optionally namespaced:
//   <function_calls>
//   <invoke name="read_file">
//   <parameter name="filePath">/a/b.ts</parameter>
//   </invoke>
//   </function_calls>
// DeepSeek falls back to this dialect no matter what the system prompt asks
// for, so it is parsed rather than fought. Closing tags stay optional, as
// everywhere else here — a block runs to the next tag or to the end.
// Anything before the tag name, up to and including its delimiter. DeepSeek
// prefixes the whole dialect with its own marker — `<｜｜DSML｜｜invoke …>`,
// built from fullwidth bars rather than a colon — so the prefix cannot be
// spelled as `\w+:`. Requiring a non-word character last keeps it from eating
// into the tag name itself: `<myinvoke>` is not `<ns:invoke>`. `=` and quotes
// are excluded so the prefix cannot swallow another dialect's syntax either —
// without that, `<function=read_file>` parses as tag `read_file` in namespace
// `function=` and loses every argument.
// DeepSeek also leaves a space between its marker and the name at times:
// `<｜｜DSML｜｜ invoke …>`. Only after a bar — `<!-- invoke name="x" -->` in
// an answer must stay a comment.
const NS_CHAR = "[^\\s<>/=\"']";
const NS_BODY = `${NS_CHAR}{0,24}(?:(?!\\w)${NS_CHAR}|[|\\uFF5C][ \\t]+)`;
export const XML_NS_PREFIX = `(?:${NS_BODY})?`;
const NS = XML_NS_PREFIX;
// The wrapper tag around a batch of calls, with its prefix. DeepSeek shortens
// it to a bare `calls` (`<｜｜DSML｜｜ calls>`), accepted only behind a prefix:
// `<calls>` on its own is plausible prose.
export const XML_WRAP_TAG = `(?:${NS}(?:function_calls|tool_calls)|${NS_BODY}calls)`;
const WRAP = XML_WRAP_TAG;
// `[^>]*` after the name: models hang extra attributes off both tags, e.g.
// `<parameter name="query" string="true">`.
const INVOKE_RE = new RegExp(
  `<${NS}invoke\\s+name\\s*=\\s*["']?([\\w.:-]+)["']?[^>]*>([\\s\\S]*?)` +
    `(?=</${NS}invoke>|<${NS}invoke\\b|</${WRAP}>|$)`,
  'gi',
);
const XML_PARAMETER_ATTR_RE = new RegExp(
  `<${NS}parameter\\s+name\\s*=\\s*["']?([\\w.:-]+)["']?[^>]*>([\\s\\S]*?)` +
    `(?=</${NS}parameter>|<${NS}parameter\\b|</${NS}invoke>|</${WRAP}>|$)`,
  'gi',
);
/** A hold that is this dialect rather than prose that merely says "<invoke". */
const INVOKE_PROTOCOL_RE = new RegExp(
  `<${WRAP}>|<${NS}invoke\\s+name\\s*=`,
  'i',
);
const INVOKE_MARKER_RE = new RegExp(`<(?:${NS}invoke|${WRAP})\\b`, 'i');
/**
 * Tail of a buffer that has opened a namespaced protocol tag but not yet
 * reached its name (`<｜｜DSML｜｜too`, `<ns:inv`). The literal markers cover the
 * bare spellings; this one exists because the prefix alone can be longer than
 * the holdback, which used to leak `<｜｜DSML｜｜tool_calls>` into the chat.
 *
 * The delimiter is restricted to a bar or a non-ASCII character, so ordinary
 * markup at a chunk boundary — `<div`, `<!--`, `<x-widget`, `<https:` — is not
 * held. A plain `ns:` prefix needs no rule here: `<ns:invoke` is shorter than
 * the holdback and is still whole when the marker scan reaches it.
 */
const NS_PARTIAL_TAIL_RE = new RegExp(
  `<${NS_CHAR}{0,24}(?:[|\\u0080-\\uffff]|[|\\uFF5C][ \\t])\\w{0,14}$`,
);

function parseInvokeTagCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];
  for (const match of text.matchAll(INVOKE_RE)) {
    const name = match[1]?.trim();
    if (name) {
      calls.push(
        createToolCallChunk({
          name,
          argumentsValue: parseXmlParameters(match[2] ?? ''),
        }),
      );
    }
  }
  return calls;
}

// A third DeepSeek dialect, carrying no attributes at all — the tool name is a
// tag of its own and so is every parameter:
//   <tool_call <read_file> <path>/a/b.ts</path> <startLine>720</startLine> </read_file>
// Only the `<tool_call` anchor separates this from ordinary XML in an answer,
// so it is required; the attribute form `<tool_call name="…">` belongs to
// `parseAttributeTagCalls` and is excluded here. Closing tags stay optional.
const TOOL_CALL_TAG_RE = new RegExp(
  `<${NS}tool_call\\s*>\\s*<${NS}([\\w.-]+)\\s*>([\\s\\S]*?)` +
    `(?=</${NS}\\1\\s*>|<${NS}tool_call\\s*>|$)`,
  'gi',
);
/** `<key>value</key>` pairs; a nested tag inside a value is left alone. */
const SIMPLE_PARAM_RE = /<([\w.-]+)\s*>([\s\S]*?)<\/\1\s*>/g;

function parseToolCallTagCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];

  for (const match of text.matchAll(TOOL_CALL_TAG_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;

    const args: Record<string, unknown> = {};
    for (const param of (match[2] ?? '').matchAll(SIMPLE_PARAM_RE)) {
      const key = param[1]?.trim();
      if (key) args[key] = coerceValue(param[2] ?? '', true);
    }

    calls.push(createToolCallChunk({ name, argumentsValue: args }));
  }

  return calls;
}

// Second MiMo variant: name and arguments in separate tags. The arguments block
// is optional (calls without parameters) and often left unclosed.
const TAG_TOOL_NAME_RE =
  /<tool_name>\s*([\w.:-]+)\s*(?:<\/tool_name>|$)([\s\S]*?)(?=<tool_name>|$)/gi;
const TAG_TOOL_ARGS_RE =
  /<tool_arguments>([\s\S]*?)(?:<\/tool_arguments>|<\/tool_call>|$)/i;

function parseTagPairCalls(text: string): ToolCallChunk[] {
  const calls: ToolCallChunk[] = [];

  for (const match of text.matchAll(TAG_TOOL_NAME_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    const argsBlock = TAG_TOOL_ARGS_RE.exec(match[2] ?? '');
    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: argsBlock
          ? parseArgumentsBlock(argsBlock[1] ?? '')
          : {},
      }),
    );
  }

  return calls;
}

/**
 * Body of a tag whose name lives outside it: usually a JSON object of
 * arguments, sometimes `<parameter=…>` pairs.
 *
 * Models often repeat the whole call envelope inside the tag
 * (`<tool_call name="read_file">{"name":"read_file","arguments":{…}}`), so an
 * envelope is unwrapped to its arguments — otherwise the real parameters end up
 * nested one level too deep and the tool sees none of them.
 */
function parseArgumentsBlock(raw: string): Record<string, unknown> {
  const body = raw.trim();
  if (!body) return {};

  const start = body.indexOf('{');
  if (start !== -1) {
    const balanced = extractBalancedJsonAt(body, start);
    const parsed = asObject(balanced ? tryParseJson(balanced.json) : undefined);
    if (parsed) {
      return unwrapNestedCall(parsed) ?? parsed;
    }
  }

  return parseXmlParameters(body);
}

function parseXmlParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  // `<parameter=key>` and `<parameter name="key">` — models mix both freely,
  // sometimes inside a single call.
  for (const pattern of [XML_PARAMETER_RE, XML_PARAMETER_ATTR_RE]) {
    for (const param of body.matchAll(pattern)) {
      const key = param[1]?.trim();
      if (key) args[key] = coerceValue(param[2] ?? '', true);
    }
  }
  return args;
}

function parseKeyValueArgs(rawArgs: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const pairRegex =
    /([a-zA-Z_][\w]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,]+)(?:,\s*|$)/g;

  for (const pair of rawArgs.matchAll(pairRegex)) {
    const value = pair[2];
    if (value !== undefined) result[pair[1] ?? ''] = coerceValue(value.trim(), false);
  }
  return result;
}

/** Turns a textual value into its JSON type (quotes, numbers, booleans, JSON). */
function coerceValue(raw: string, xml: boolean): unknown {
  // For XML the leading newline is markup and trailing spaces precede the tag.
  const value = xml ? raw.replace(/^\r?\n/, '').replace(/\s+$/, '') : raw;
  if (!value) return '';

  if (!xml) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    if (value === 'null') return null;
  }

  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (xml ? /^-?\d+(\.\d+)?$/.test(value) : !Number.isNaN(Number(value))) {
    return Number(value);
  }
  if (xml && /^[[{]/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // not JSON — keep as string
    }
  }
  return value;
}

/**
 * Best-effort repair of the broken JSON small models emit: trailing garbage,
 * missing braces/quotes, raw newlines and unescaped quotes inside values.
 *
 * Quote heuristic: a `"` inside a string closes it only when the next
 * significant char is structural (`,` `:` `}` `]`) or the end; otherwise it is
 * escaped. The result must still pass JSON.parse at the call site.
 */
function repairToolCallJson(text: string, start: number): string | undefined {
  if (text[start] !== '{') return undefined;

  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? '';

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j] ?? '')) j += 1;
        const next = text[j];
        if (next === undefined || ',:}]'.includes(next)) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
      continue;
    }

    out += ch;
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}' && --depth === 0) {
      return out; // object closed — drop whatever trails it
    }
  }

  // Ran out of input: close the dangling string and braces.
  if (inString) out += '"';
  return out + '}'.repeat(Math.max(0, depth));
}

function extractBalancedJsonAt(
  text: string,
  start: number,
): { json: string; end: number } | undefined {
  if (text[start] !== '{') return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? '';

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) {
      return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }

  return undefined;
}

/** Single pass so a long unbalanced buffer cannot degrade to O(n²). */
function extractBalancedJsonObjects(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0 && --depth === 0 && start !== -1) {
      result.push(text.slice(start, i + 1));
      start = -1;
    }
  }

  return result;
}

interface ParsedCall {
  name?: string;
  arguments?: unknown;
  params?: unknown;
  input?: unknown;
}

function tryParseJson(raw: string): ParsedCall | undefined {
  try {
    return JSON.parse(raw) as ParsedCall;
  } catch {
    return undefined;
  }
}

function argumentsOf(parsed: ParsedCall): unknown {
  return parsed.arguments ?? parsed.params ?? parsed.input;
}

/** Where the tool name can sit. `tool`/`function` only when they hold a string. */
const NAME_KEYS = [
  'name',
  'tool',
  'tool_name',
  'toolName',
  'function',
  'function_name',
  'recipient_name',
];

/** Where the arguments can sit. */
const ARGS_KEYS = [
  'arguments',
  'args',
  'parameters',
  'params',
  'input',
  'tool_arguments',
  'toolArguments',
  'kwargs',
];

/** Wrappers models put the call into. The first four are protocol by themselves. */
const ENVELOPE_KEYS = [
  'tool_call',
  'toolCall',
  'tool_calls',
  'toolCalls',
  'tool_use',
  'toolUse',
  'function_call',
  'functionCall',
  'function',
  'tool',
  'action',
  'call',
];
const PROTOCOL_ENVELOPE_KEYS = new Set([
  'tool_call',
  'toolcall',
  'tool_calls',
  'toolcalls',
  'tool_use',
  'tooluse',
  'function_call',
  'functioncall',
]);

/**
 * Bookkeeping fields that are never arguments. Deliberately narrow: `id`,
 * `type` and `index` are left out because tools do declare parameters by those
 * names, and an extra key a tool ignores is cheaper than a missing one.
 */
const META_KEYS = new Set([
  'call_id',
  'callid',
  'tool_call_id',
  'toolcallid',
  'tool_use_id',
  'tooluseid',
  'thought',
  'thinking',
  'reasoning',
  'recipient',
]);

const CONTAINER_KEYS = new Set(
  [...ARGS_KEYS, ...ENVELOPE_KEYS].map((k) => k.toLowerCase()),
);

interface NormalizedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Pulls calls out of an already-parsed JSON value, in every shape models emit:
 * the protocol one, `tool`/`parameters` aliases, the OpenAI
 * `{"function":{"name":…,"arguments":"{…}"}}` pair, and wrappers such as
 * `{"tool_call": {…}}` or `{"tool_calls": [ … ]}`.
 *
 * `anchored` means the JSON came from an explicit marker (a ```` ```tool_call ````
 * fence, a `<tool_call …>` tag, a protocol wrapper). Only there may the remaining
 * top-level keys be read as the arguments: models constantly write
 * `{"name":"read_file","filePath":"…"}` without the `arguments` object, and
 * dropping those keys used to hand the tool an empty argument set. In free text
 * that same shape is ordinary data (`{"name":"my-pkg","version":"1.0"}`), so it
 * is left alone.
 */
function callsFromJsonValue(
  value: unknown,
  anchored: boolean,
  depth = 0,
): NormalizedCall[] {
  if (depth > 4) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      callsFromJsonValue(item, anchored, depth + 1),
    );
  }

  const obj = asObject(value);
  if (!obj) return [];

  const own = namedBy(obj);

  for (const key of ENVELOPE_KEYS) {
    const inner = obj[key];
    // A string here is the tool name, not a wrapper.
    if (inner === undefined || inner === null || typeof inner !== 'object') {
      continue;
    }
    const isProtocol = PROTOCOL_ENVELOPE_KEYS.has(key.toLowerCase());
    // `function`/`tool`/`action` are only a wrapper when the object does not
    // name a tool itself — otherwise they are that tool's own parameter.
    if (!isProtocol && own) continue;

    const wrapped = callsFromJsonValue(inner, anchored || isProtocol, depth + 1);
    if (wrapped.length > 0) return wrapped;
  }

  if (!own) return [];

  const args = argumentsFromObject(obj, own.key, anchored);
  return args ? [{ name: own.name, args }] : [];
}

function argumentsFromObject(
  obj: Record<string, unknown>,
  nameKey: string,
  anchored: boolean,
): Record<string, unknown> | undefined {
  for (const key of ARGS_KEYS) {
    const raw = obj[key];
    if (raw === undefined) continue;
    // OpenAI-style: the arguments arrive as a JSON string.
    const args = asObject(typeof raw === 'string' ? tryParseJson(raw) : raw);
    if (args) return unwrapNestedCall(args) ?? args;
  }

  if (!anchored) return undefined;

  // Arguments inlined next to the name. An empty result is still a call —
  // some tools take no parameters at all. Only the name and the containers
  // already read above are dropped: a plain `input: "…"` is a real parameter.
  return Object.fromEntries(
    Object.entries(obj).filter(([key, value]) => {
      const lower = key.toLowerCase();
      if (key === nameKey || META_KEYS.has(lower)) return false;
      const container = value !== null && typeof value === 'object';
      return !(container && CONTAINER_KEYS.has(lower));
    }),
  );
}

/**
 * `{"name":…,"arguments":{…}}` written where only the arguments were expected —
 * the whole envelope repeated one level down. Requires both fields: a lone
 * `name` is a legitimate parameter of tools like write_file.
 */
function unwrapNestedCall(
  obj: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!namedBy(obj)) return undefined;

  for (const key of ARGS_KEYS) {
    const raw = obj[key];
    if (raw === undefined) continue;
    const inner = asObject(typeof raw === 'string' ? tryParseJson(raw) : raw);
    if (inner) return inner;
  }

  return undefined;
}

/** The tool name this object carries, and the key it was found under. */
function namedBy(
  obj: Record<string, unknown>,
): { name: string; key: string } | undefined {
  for (const key of NAME_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return { name: value.trim(), key };
    }
  }
  return undefined;
}

/** Calls from a JSON string, or none when it is not a call at all. */
function callsFromJsonText(raw: string, anchored: boolean): NormalizedCall[] {
  const parsed = tryParseJson(raw);
  return parsed ? callsFromJsonValue(parsed, anchored) : [];
}

function toChunks(calls: readonly NormalizedCall[]): ToolCallChunk[] {
  return calls.map((call) =>
    createToolCallChunk({ name: call.name, argumentsValue: call.args }),
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One routed tool call with its parsed shape attached. */
export interface RoutedToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

/** Builds a tool_call chunk; the args text is JSON of `argumentsValue`. */
export function createToolCallChunk(params: {
  name: string;
  argumentsValue?: unknown;
  argumentsPart?: string;
  callId?: string;
}): ToolCallChunk {
  const args =
    params.argumentsPart ??
    (typeof params.argumentsValue === 'string'
      ? params.argumentsValue
      : JSON.stringify(params.argumentsValue ?? {}));

  return {
    type: 'tool_call',
    callId: params.callId ?? crypto.randomUUID(),
    name: params.name,
    argumentsPart: args,
  };
}

// Held text that stops looking like a tool call is released as plain text
// (false marker hit on markdown/code).
const MAX_HOLD_CHARS = 4096;
// Hard cap for confirmed calls with huge arguments (a whole file).
const MAX_HOLD_HARD_CAP_CHARS = 262144;
// Tail kept back to catch a marker split across chunks (len("```tool_call") - 1).
const MARKER_HOLDBACK_CHARS = 11;

// Small models "play out" the joined transcript after their answer, echoing the
// role prefixes, our tool-result placeholder, or a whole tool result with its
// call id.
//
// Everything after a marker is dropped, so a false positive costs the rest of
// the answer *and* the tool call that was about to follow. Each alternative is
// therefore narrowed to what the prompt builder actually writes, and `findCut`
// additionally ignores anything inside a ``` block.
const TRANSCRIPT_CUT_PATTERN = new RegExp(
  [
    // `\nUser: ` / `\nAssistant: ` at column 0, in the exact casing the prompt
    // uses. Indented or lower-case `user:` is a config/object key — the answer
    // to a question about code is full of them.
    '\\n(?:User|Assistant):(?=[ \\t\\n])',
    // our own placeholder, which models echo verbatim
    '\\[[Tt]ool result id=',
    // a call id echoed anywhere, e.g. `Environment: [toolu_bdrk_018gnVobT…]`.
    // Generated ids always carry a digit or a capital; `[call_procedure_key]`
    // written in prose does not.
    '\\[(?:toolu|call|tooluse)_(?=[\\w-]*[A-Z0-9])[\\w-]{6,}',
  ].join('|'),
  'g',
);
// Longest marker prefix worth holding back: len("[Tool result id=") - 1.
const TRANSCRIPT_CUT_HOLDBACK_CHARS = 15;
// A cut drops the whole line its marker sits on, so the current partial line is
// held back too — otherwise a label like `Environment: ` is already in the chat
// by the time the marker arrives. Bounded, so a long paragraph still streams.
const TRANSCRIPT_CUT_LINE_HOLDBACK_CHARS = 200;

/**
 * Position inside the ``` fences of the answer, carried across chunks.
 *
 * A quoted chat log, a YAML `user:` key or a snippet of our own protocol sit
 * inside a code block, where none of the transcript markers mean what they mean
 * in prose. `head`/`decided` track the line being scanned so a fence split
 * across two chunks is still recognised.
 */
interface FenceState {
  open: boolean;
  head: string;
  decided: boolean;
}

const INITIAL_FENCE_STATE: FenceState = {
  open: false,
  head: '',
  decided: false,
};

/** Advances the fence state over the next contiguous piece of the answer. */
function scanFences(text: string, state: FenceState): FenceState {
  let { open, head, decided } = state;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '\n') {
      head = '';
      decided = false;
      continue;
    }
    if (decided) continue;
    // Indentation before a fence is common in lists; skip it.
    if (!head && (ch === ' ' || ch === '\t')) continue;

    head += ch;
    if (head === '`' || head === '``') continue;
    if (head === '```') open = !open;
    decided = true;
  }

  return { open, head, decided };
}

/**
 * Unpaired closing tags. The model drops them into the stream away from the
 * call itself, so no opening marker holds them back and they leak into the chat.
 */
const STRAY_CLOSE_TAGS = [
  '</tool_call' + '>',
  '</tool_calls>',
  '</function>',
  '</function_calls>',
  '</invoke>',
  '</parameter>',
  '</tool_name>',
  '</tool_arguments>',
];
// The namespace prefix is optional throughout: DeepSeek emits the Anthropic
// dialect bare, `ns:`-prefixed and behind its own `<｜｜DSML｜｜…>` marker.
const PROTOCOL_TAGS =
  'tool_calls|tool_call|function_calls|function|invoke|parameter|tool_name|tool_arguments';
// The prefixed-only `calls` wrapper rides along through XML_WRAP_TAG.
const PROTOCOL_TAG = `(?:${XML_NS_PREFIX}(?:${PROTOCOL_TAGS})|${XML_WRAP_TAG})`;
const STRAY_CLOSE_TAG_RE = new RegExp(
  `</${PROTOCOL_TAG}>[ \t]*\n?`,
  'gi',
);

// Opening and closing halves of the tag set above, for the case where only one
// side of a call survived. `[^>]*` carries the attributes some dialects add.
const STRAY_PROTOCOL_TAG_RE = new RegExp(
  `<${PROTOCOL_TAG}\\b[^>]*>|</${PROTOCOL_TAG}>`,
  'gi',
);
// A whole `<function_calls>…</function_calls>` / `<invoke …>…</invoke>` block,
// closing tag optional.
const WRAPPED_CALLS_RE = new RegExp(
  `<${XML_WRAP_TAG}>[\\s\\S]*?(?:</${XML_WRAP_TAG}>|$)`,
  'gi',
);
const INVOKE_BLOCK_RE = new RegExp(
  `<${XML_NS_PREFIX}invoke\\b[^>]*>[\\s\\S]*?(?:</${XML_NS_PREFIX}invoke>|$)`,
  'gi',
);

/** Length of a tail that looks like the start of a closing tag (`<`, `</too`…). */
function trailingCloseTagPrefixLen(text: string): number {
  let longest = 0;
  for (const tag of STRAY_CLOSE_TAGS) {
    for (let len = Math.min(tag.length - 1, text.length); len > 0; len -= 1) {
      if (text.endsWith(tag.slice(0, len))) {
        longest = Math.max(longest, len);
        break;
      }
    }
  }
  return longest;
}

export function stripDanglingToolCallMarkers(text: string): string {
  return (
    text
      .replace(/```tool_call\s*```?/gi, '')
      .replace(/```tool_call\s*$/gim, '')
      .replace(/^\s*```tool_call\s*\n?/gim, '')
      .replace(/^\s*<tool_call\b[^>]*>\s*$/gim, '')
      // Orphaned MiMo/Qwen-Coder XML tags: the model regularly loses one side.
      .replace(/<tool_call\b[^>]*>|<\/tool_call>/gi, '')
      .replace(/<function\s*=\s*[\w.:-]+\s*>|<\/function>/gi, '')
      .replace(/<parameter\s*=\s*[\w.:-]+\s*>/gi, '')
      // Anthropic dialect, opening and closing halves alike.
      .replace(STRAY_PROTOCOL_TAG_RE, '')
      .replace(/<\/?tool_name>|<\/?tool_arguments>/gi, '')
      .trim()
  );
}

/**
 * Cleans the held region once a call was (or was not) extracted from it.
 * Runs on the raw buffer, before the tags are stripped: whole blocks can only
 * be matched while their opening tag is still there.
 */
function sanitizeHoldRemainder(text: string): string {
  if (!text) return '';
  return (
    stripToolCallBlocks(text)
      // `<tool_call name="x">{…}` — the arguments carry no `name` of their own,
      // so nothing else would recognise them as protocol. Closing tag optional.
      .replace(/<tool_call\b[^>]*>[\s\S]*?(?:<\/tool_call>|$)/gi, '\n\n')
      .replace(/<function\s*=\s*[\w.:-]+\s*>[\s\S]*?<\/function>/gi, '\n\n')
      .replace(WRAPPED_CALLS_RE, '\n\n')
      .replace(INVOKE_BLOCK_RE, '\n\n')
      .replace(
        /<tool_name>[\s\S]*?<\/tool_name>(\s*<tool_arguments>[\s\S]*?<\/tool_arguments>)?/gi,
        '\n\n',
      )
      .replace(/^\s*Assistant:\s?/gim, '')
      .replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, '\n')
      // Orphaned fences left behind by the removals above; safe here because
      // this only ever runs on a hold region, never on normal prose.
      .replace(/```[a-zA-Z0-9_-]*/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
  );
}

/**
 * Routes a text stream into text / tool_call chunks.
 *
 * Web models (DeepSeek/Qwen/Kimi) have no native tool_calls — they print
 * the call into the answer (```tool_call … ```). This class spots the marker
 * with a sliding window, holds the candidate until the stream ends and then
 * parses it, so the raw protocol never reaches the chat.
 *
 *   for (...) yield* router.route(textChunk);
 *   yield* router.finish();
 */
export class StreamingToolCallRouter {
  private pendingBuffer = '';
  private closeTagTail = '';
  private holdBuffer = '';
  private holdActive = false;
  private cutActive = false;
  private cutBuffer = '';
  /** Fence state at `cutBuffer[0]`, i.e. everything already emitted. */
  private fence: FenceState = INITIAL_FENCE_STATE;

  constructor(
    private readonly allowToolCalls: boolean,
    private readonly logger?: (msg: string) => void,
    private readonly logPrefix = '',
  ) {}

  /**
   * True while a potential tool call is held (marker seen, call not finished).
   * Callers use it to avoid cutting the stream mid-call.
   */
  get holding(): boolean {
    return this.holdActive;
  }

  /**
   * True once a fabricated next turn was detected and the rest is dropped. The
   * caller should stop the upstream so the model stops burning tokens.
   */
  get cut(): boolean {
    return this.cutActive;
  }

  /**
   * Transcript guard: emits text up to the fabricated turn and discards the
   * rest. The holdback keeps a tail so a split boundary is not missed.
   */
  *route(rawText: string): Iterable<ToolCallChunk> {
    if (!rawText || this.cutActive) {
      return;
    }

    this.cutBuffer += rawText;
    const cutIdx = this.findCut();
    if (cutIdx !== -1) {
      this.cutActive = true;
      this.logger?.(
        `${this.logPrefix}transcript boundary at ${JSON.stringify(
          this.cutBuffer.slice(cutIdx, cutIdx + 40),
        )} — dropping the rest of the answer`,
      );
      // Drop the whole line the marker sits on: a label in front of it
      // (`Environment: [toolu_…]`) belongs to the echo, not to the answer.
      const lineStart = this.cutBuffer.lastIndexOf('\n', cutIdx) + 1;
      const safe = this.cutBuffer.slice(0, lineStart).replace(/\s+$/, '');
      this.cutBuffer = '';
      if (safe) yield* this.routeSafe(safe);
      return;
    }

    const lineStart = this.cutBuffer.lastIndexOf('\n') + 1;
    const holdback = Math.max(
      TRANSCRIPT_CUT_HOLDBACK_CHARS,
      Math.min(
        this.cutBuffer.length - lineStart,
        TRANSCRIPT_CUT_LINE_HOLDBACK_CHARS,
      ),
    );

    const emitUpTo = this.cutBuffer.length - holdback;
    if (emitUpTo <= 0) {
      return;
    }
    const safe = this.cutBuffer.slice(0, emitUpTo);
    this.cutBuffer = this.cutBuffer.slice(emitUpTo);
    this.fence = scanFences(safe, this.fence);
    yield* this.routeSafe(safe);
  }

  /**
   * First transcript marker that is really a fabricated turn: index in
   * `cutBuffer`, or -1. Markers inside a ``` block are quoted material — the
   * answer to a question about code is full of them — and are skipped.
   */
  private findCut(): number {
    TRANSCRIPT_CUT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TRANSCRIPT_CUT_PATTERN.exec(this.cutBuffer)) !== null) {
      const upTo = this.cutBuffer.slice(0, match.index);
      if (!scanFences(upTo, this.fence).open) return match.index;
    }

    return -1;
  }

  /** Flushes the buffers: parses a tool call, or emits the tail as text. */
  *finish(): Iterable<ToolCallChunk> {
    yield* this.flushCutTail();
    const { holdBuffer, tailText } = this.takeBuffers();

    if (holdBuffer) {
      const toolChunks = Array.from(
        parseToolCallsFromText(holdBuffer, {
          logger: this.logger,
          logPrefix: this.logPrefix,
        }),
      ).filter((c) => c.type === 'tool_call');
      const remainder = stripDanglingToolCallMarkers(
        sanitizeHoldRemainder(holdBuffer),
      );

      if (toolChunks.length > 0) {
        yield* toolChunks;
        if (remainder.trim()) yield* this.emitText(remainder);
      } else {
        yield* this.emitText(this.releaseHold(holdBuffer, remainder));
      }
    }

    if (tailText) yield* this.emitText(tailText);
    yield* this.flushCloseTagTail();
  }

  /**
   * Text of a hold that produced no call. When nothing in it looks like the
   * protocol the marker was a false positive on ordinary content — a JSON
   * snippet the user asked for — and it is released exactly as it arrived:
   * `sanitizeHoldRemainder` is meant for protocol junk and would eat the code
   * fences and the indentation of a legitimate block.
   */
  private releaseHold(holdBuffer: string, remainder: string): string {
    if (!looksLikeToolCallStart(holdBuffer)) return holdBuffer;
    return remainder || holdBuffer.trim();
  }

  /**
   * Flushes everything as text without parsing. Used when the calls already
   * arrived through another channel (native tool_calls) and the held text must
   * not turn into a duplicate.
   */
  *finishAsText(): Iterable<ToolCallChunk> {
    yield* this.flushCutTail();
    const { holdBuffer, tailText } = this.takeBuffers();

    if (holdBuffer) {
      yield* this.emitText(
        this.releaseHold(
          holdBuffer,
          stripDanglingToolCallMarkers(sanitizeHoldRemainder(holdBuffer)),
        ),
      );
    }
    if (tailText) yield* this.emitText(tailText);
    yield* this.flushCloseTagTail();
  }

  private takeBuffers(): { holdBuffer: string; tailText: string } {
    const holdBuffer = this.holdActive ? this.holdBuffer : '';
    const tailText = this.holdActive ? '' : this.pendingBuffer;
    this.pendingBuffer = '';
    this.holdBuffer = '';
    this.holdActive = false;
    return { holdBuffer, tailText };
  }

  private *routeSafe(rawText: string): Iterable<ToolCallChunk> {
    if (!this.allowToolCalls) {
      yield* this.emitText(rawText);
      return;
    }

    if (this.holdActive) {
      this.holdBuffer += rawText;
      const overSoftLimit = this.holdBuffer.length >= MAX_HOLD_CHARS;
      const overHardCap = this.holdBuffer.length >= MAX_HOLD_HARD_CAP_CHARS;
      const looksLikeCall = looksLikeToolCallStart(this.holdBuffer);
      if ((overSoftLimit && !looksLikeCall) || overHardCap) {
        // Same rule as `releaseHold`: content that never looked like protocol
        // goes back out untouched, fences and indentation included.
        yield* this.emitText(
          looksLikeCall
            ? stripDanglingToolCallMarkers(this.holdBuffer)
            : this.holdBuffer,
        );
        this.holdBuffer = '';
        this.holdActive = false;
      }
      return;
    }

    this.pendingBuffer += rawText;
    const markerIdx = findToolCallMarkerStart(this.pendingBuffer);

    if (markerIdx !== -1) {
      yield* this.emitText(this.pendingBuffer.slice(0, markerIdx));
      this.holdBuffer = this.pendingBuffer.slice(markerIdx);
      this.pendingBuffer = '';
      this.holdActive = true;
      return;
    }

    const emitUpTo = this.pendingBuffer.length - MARKER_HOLDBACK_CHARS;
    if (emitUpTo > 0) {
      yield* this.emitText(this.pendingBuffer.slice(0, emitUpTo));
      this.pendingBuffer = this.pendingBuffer.slice(emitUpTo);
    }
  }

  /** Single exit for text: strips orphaned closing tags of the protocol. */
  private *emitText(text: string): Iterable<ToolCallChunk> {
    let content = (this.closeTagTail + text).replace(STRAY_CLOSE_TAG_RE, '');
    this.closeTagTail = '';

    // A tag split across chunks must not be emitted in halves — the chat would
    // glue them back into a visible `</tool_call…>`.
    const partial = trailingCloseTagPrefixLen(content);
    if (partial > 0) {
      this.closeTagTail = content.slice(content.length - partial);
      content = content.slice(0, content.length - partial);
    }

    if (content) yield { type: 'text', content };
  }

  private *flushCloseTagTail(): Iterable<ToolCallChunk> {
    const tail = this.closeTagTail;
    this.closeTagTail = '';
    if (tail) yield { type: 'text', content: tail };
  }

  /** Releases the guard holdback when no boundary ever showed up. */
  private *flushCutTail(): Iterable<ToolCallChunk> {
    if (this.cutBuffer && !this.cutActive) {
      const tail = this.cutBuffer;
      this.cutBuffer = '';
      yield* this.routeSafe(tail);
    }
  }
}
