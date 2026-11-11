// HTTP end-to-end for the git-like undo path — the ONE check the unit suite cannot make.
//
// It drives the real server over HTTP against a LIVE Roblox Studio place, with the fake LLM emitting
// the `studio-real-edit` script (one `studio.multi_edit` that rewrites an existing script), then
// reads the script back through Studio's OWN MCP server so the assertion never trusts our own API.
//
// Why it exists: the app's `ServiceMcpGateway` publishes the real tools PREFIXED
// (`studio.multi_edit`) while forwarding the real schemas. Snapshot/restore must therefore decide
// real-vs-legacy from the SCHEMA, not the name — a prefix heuristic made every snapshot read fail
// through the app while all fake-gateway unit tests stayed green. This probe is what caught it (and
// two field bugs: a `multi_edit` fixture missing the required `datamodel_type`, and the stream route
// silently dropping `permissionMode`, which made every `ask`-risk tool end as APPROVAL_DENIED).
//
// Usage (Node, from `server/`):
//   1. launch: MORPHI_FAKE_LLM=1 MORPHI_FAKE_SCRIPT=studio-real-edit MORPHI_LIVE_STUDIO=1 \
//              MORPHI_PORT=3099 MORPHI_TOKEN=faketest MORPHI_DB_PATH=<tmp>.db npx ts-node src/index.ts
//   2. POST /api/mcp/reconnect (the gateway connects lazily) until /api/mcp/status says
//      `connected:true, studioLinked:true`
//   3. node scripts/e2e-live-undo.mjs
// It seeds `ServerScriptService.MorphiE2E` itself and leaves the place as it found it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.MORPHI_E2E_BASE ?? 'http://127.0.0.1:3099';
const TOKEN = process.env.MORPHI_E2E_TOKEN ?? 'faketest';
const STUDIO_MCP = process.env.MORPHI_STUDIO_MCP ?? 'C:/Users/nil/AppData/Local/Roblox/mcp.bat';
const SCRIPT = 'ServerScriptService.MorphiE2E';
const V1 = 'local V = 1\nreturn V';
const V2 = 'local V = 2\nreturn V';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-morphi-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** One Studio MCP session per call: list of { name, source } reads and (optionally) a create. */
async function withStudio(run) {
  const transport = new StdioClientTransport({ command: 'cmd.exe', args: ['/c', STUDIO_MCP] });
  const client = new Client({ name: 'morphi-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function sourceOf(result) {
  const raw = result.content?.find((part) => typeof part.text === 'string')?.text ?? '';
  if (result.isError) return { ok: false, source: raw };
  const source = raw.split('\n').map((line) => line.replace(/^\s*\d+→/, '')).join('\n').replace(/\n$/, '');
  return { ok: true, source };
}

const readLive = () => withStudio(async (client) => sourceOf(await client.callTool({
  name: 'script_read',
  arguments: { target_file: SCRIPT, should_read_entire_file: true },
})));

async function seed() {
  const current = await readLive();
  if (current.ok && current.source === V1) return current;
  // `multi_edit` appends on an empty `old_string`, so only a MISSING script is created that way; an
  // existing script is reset by replacing its exact current text.
  await withStudio((client) => client.callTool({
    name: 'multi_edit',
    arguments: {
      file_path: SCRIPT,
      datamodel_type: 'Edit',
      ...(current.ok && current.source !== '' ? {} : { className: 'Script' }),
      edits: [{ old_string: current.ok ? current.source : '', new_string: V1 }],
    },
  }));
  return readLive();
}

const status = await api('GET', '/api/mcp/status');
check('MCP connected + Studio linked', status.body?.connected === true && status.body?.studioLinked === true,
  `${status.body?.toolCount} tools, studio ${status.body?.studio?.name}`);
if (status.body?.connected !== true) { console.log('aborting: no live Studio'); process.exit(1); }

const before = await seed();
check('seed script reads as v1', before.ok && before.source === V1, JSON.stringify(before.source));

const project = await api('POST', '/api/projects', { name: `e2e-undo-${Date.now()}` });
check('project created', project.status === 201, `status ${project.status}`);
const session = await api('POST', '/api/sessions', { projectId: project.body.id, model: 'fake-tools' });
check('session created', session.status === 201, `status ${session.status}`);
const sessionId = session.body.id;

// `permissionMode: full` bypasses the approval gate (multi_edit asks under `ask`/`balanced`), so the
// turn settles without a modal.
const turn = await fetch(`${BASE}/api/chat/stream`, {
  method: 'POST',
  headers: { 'x-morphi-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, message: '/script studio-real-edit', model: 'fake-tools', permissionMode: 'full' }),
});
const sse = await turn.text();
check('turn stream finished', turn.status === 200, `status ${turn.status}, ${sse.length} bytes, multi_edit seen: ${/multi_edit/.test(sse)}`);

const afterEdit = await readLive();
check('live script mutated to v2 by the turn', afterEdit.ok && afterEdit.source === V2, JSON.stringify(afterEdit.source));

const checkpoints = await api('GET', `/api/sessions/${sessionId}/checkpoints`);
const rows = Array.isArray(checkpoints.body) ? checkpoints.body : [];
const restorable = rows.filter((row) => row.manifest?.restorable === true);
check('checkpoint recorded as restorable', restorable.length > 0,
  `${rows.length} checkpoint(s): ${rows.map((row) => `restorable=${row.manifest?.restorable}`).join(', ')}`);
if (restorable.length === 0) console.log(JSON.stringify(rows, null, 2).slice(0, 2000));

const callIds = [...new Set(restorable.map((row) => row.manifest?.callId ?? row.callId).filter(Boolean))];
check('callIds collected for undo', callIds.length > 0, callIds.join(', '));

const undo = await api('POST', `/api/sessions/${sessionId}/undo-turn`, { callIds });
check('undo-turn 200', undo.status === 200, `status ${undo.status} ${JSON.stringify(undo.body).slice(0, 400)}`);
check('undo reported a restore', undo.body?.status === 'restored', JSON.stringify(undo.body).slice(0, 600));

const afterUndo = await readLive();
check('live script back to v1', afterUndo.ok && afterUndo.source === V1, JSON.stringify(afterUndo.source));

console.log(failures === 0 ? '\nE2E OK' : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
