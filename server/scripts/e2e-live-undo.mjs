// HTTP end-to-end for the git-like undo path — the ONE check the unit suite cannot make.
//
// It drives the real server over HTTP against a LIVE Roblox Studio place, with the fake LLM emitting
// real `studio.multi_edit` calls, then reads the scripts back through Studio's OWN MCP server so the
// assertions never trust our own API.
//
// Why it exists: the app's `ServiceMcpGateway` publishes the real tools PREFIXED
// (`studio.multi_edit`) while forwarding the real schemas. Snapshot/restore must therefore decide
// real-vs-legacy from the SCHEMA, not the name — a prefix heuristic made every snapshot read fail
// through the app while all fake-gateway unit tests stayed green. This probe is what caught it (and
// two field bugs: a `multi_edit` fixture missing the required `datamodel_type`, and the stream route
// silently dropping `permissionMode`, which made every `ask`-risk tool end as APPROVAL_DENIED).
//
// Two scenarios, because they prove different contracts:
//   1. single  — one call, one checkpoint, undo restores it and the live source reads back exactly;
//   2. batch    — TWO calls in ONE turn, and the turn undo must be all-or-nothing: with one target
//                 gone, NOTHING is written (the untouched script keeps the turn's new text), and
//                 once the target is back the whole turn restores in one request.
//
// Usage (Node, from `server/`):
//   1. launch: MORPHI_FAKE_LLM=1 MORPHI_FAKE_SCRIPT=studio-real-edit MORPHI_LIVE_STUDIO=1 \
//              MORPHI_PORT=3099 MORPHI_TOKEN=faketest MORPHI_DB_PATH=<tmp>.db npx ts-node src/index.ts
//   2. POST /api/mcp/reconnect (the gateway connects lazily) until /api/mcp/status says
//      `connected:true, studioLinked:true`
//   3. node scripts/e2e-live-undo.mjs
// It seeds its own fixture scripts and destroys them again, so the place is left as it was found.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.MORPHI_E2E_BASE ?? 'http://127.0.0.1:3099';
const TOKEN = process.env.MORPHI_E2E_TOKEN ?? 'faketest';
const STUDIO_MCP = process.env.MORPHI_STUDIO_MCP ?? 'C:/Users/nil/AppData/Local/Roblox/mcp.bat';

const A = 'ServerScriptService.MorphiE2E';
const B = 'ServerScriptService.MorphiE2EB';
const A1 = 'local V = 1\nreturn V';
const A2 = 'local V = 2\nreturn V';
const B1 = 'local W = 1\nreturn W';
const B2 = 'local W = 2\nreturn W';

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

/** One Studio MCP session per operation: every call below talks to Studio directly. */
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

const readLive = (path) => withStudio(async (client) => sourceOf(await client.callTool({
  name: 'script_read',
  arguments: { target_file: path, should_read_entire_file: true },
})));

/** Write a script to an exact source: create when missing, exact-replace when it exists. */
async function writeLive(path, source) {
  const current = await readLive(path);
  await withStudio((client) => client.callTool({
    name: 'multi_edit',
    arguments: {
      file_path: path,
      datamodel_type: 'Edit',
      ...(current.ok ? {} : { className: 'Script' }),
      edits: [{ old_string: current.ok ? current.source : '', new_string: source }],
    },
  }));
  const after = await readLive(path);
  return after.ok && after.source === source;
}

async function destroyLive(path) {
  await withStudio((client) => client.callTool({
    name: 'execute_luau',
    arguments: {
      datamodel_type: 'Edit',
      code: `local segs = {${path.split('.').map((segment) => JSON.stringify(segment)).join(', ')}}\n`
        + 'local root = game:GetService(segs[1])\n'
        + 'for i = 2, #segs do\n  if root == nil then break end\n  root = root:FindFirstChild(segs[i])\nend\n'
        + 'if root == nil then return "missing" end\nroot:Destroy()\nreturn "ok"',
    },
  }));
}

/** Stream one turn and return the raw SSE text (the frames are asserted by the server suite). */
async function turn(sessionId, message) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'x-morphi-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message, model: 'fake-tools', permissionMode: 'full' }),
  });
  return { status: res.status, sse: await res.text() };
}

async function newSession(name) {
  const project = await api('POST', '/api/projects', { name: `${name}-${Date.now()}` });
  const session = await api('POST', '/api/sessions', { projectId: project.body.id, model: 'fake-tools' });
  return session.body.id;
}

/** The callIds of the restorable checkpoints this turn recorded. */
async function restorableCallIds(sessionId) {
  const listed = await api('GET', `/api/sessions/${sessionId}/checkpoints`);
  const rows = Array.isArray(listed.body) ? listed.body : [];
  const restorable = rows.filter((row) => row.manifest?.restorable === true);
  const callIds = [...new Set(restorable.map((row) => row.manifest?.callId ?? row.callId).filter(Boolean))];
  return { rows, restorable, callIds };
}

const status = await api('GET', '/api/mcp/status');
check('MCP connected + Studio linked', status.body?.connected === true && status.body?.studioLinked === true,
  `${status.body?.toolCount} tools, studio ${status.body?.studio?.name}`);
if (status.body?.connected !== true) { console.log('aborting: no live Studio'); process.exit(1); }

// ---------------------------------------------------------------------------------------------
// Scenario 1 — single call, single checkpoint
// ---------------------------------------------------------------------------------------------
console.log('\n[1] single-call turn');
check('seed script A reads as v1', await writeLive(A, A1), A1);

const singleSession = await newSession('e2e-undo');
const singleTurn = await turn(singleSession, '/script studio-real-edit');
check('turn stream finished', singleTurn.status === 200,
  `status ${singleTurn.status}, ${singleTurn.sse.length} bytes, multi_edit seen: ${/multi_edit/.test(singleTurn.sse)}`);

const singleAfter = await readLive(A);
check('live script A mutated to v2 by the turn', singleAfter.ok && singleAfter.source === A2, JSON.stringify(singleAfter.source));

const single = await restorableCallIds(singleSession);
check('checkpoint recorded as restorable', single.restorable.length > 0,
  `${single.rows.length} checkpoint(s): ${single.rows.map((row) => `restorable=${row.manifest?.restorable}`).join(', ')}`);
if (single.restorable.length === 0) console.log(JSON.stringify(single.rows, null, 2).slice(0, 2000));

const singleUndo = await api('POST', `/api/sessions/${singleSession}/undo-turn`, { callIds: single.callIds });
check('undo-turn 200', singleUndo.status === 200, JSON.stringify(singleUndo.body).slice(0, 400));
check('undo reported a restore', singleUndo.body?.status === 'restored', JSON.stringify(singleUndo.body).slice(0, 600));

const singleRestored = await readLive(A);
check('live script A back to v1', singleRestored.ok && singleRestored.source === A1, JSON.stringify(singleRestored.source));

// ---------------------------------------------------------------------------------------------
// Scenario 2 — two calls in one turn; undo is all-or-nothing
// ---------------------------------------------------------------------------------------------
console.log('\n[2] batch turn (2 calls, 1 turn)');
check('seed scripts A and B at v1', (await writeLive(A, A1)) && (await writeLive(B, B1)), `${A1} | ${B1}`);

const batchSession = await newSession('e2e-batch-undo');
const batchTurn = await turn(batchSession, '/script studio-batch-edit');
check('batch turn stream finished', batchTurn.status === 200,
  `${batchTurn.sse.length} bytes, multi_edit seen: ${/multi_edit/.test(batchTurn.sse)}`);

const batchA = await readLive(A);
const batchB = await readLive(B);
check('both scripts mutated to v2', batchA.source === A2 && batchB.source === B2, `${JSON.stringify(batchA.source)} | ${JSON.stringify(batchB.source)}`);

const batch = await restorableCallIds(batchSession);
check('both calls recorded as restorable checkpoints', batch.restorable.length === 2,
  `${batch.restorable.length} restorable: ${batch.callIds.join(', ')}`);

// Break ONE target: a missing script is unreadable, which the strict (turn-level) preview treats as
// drift. The other target is untouched and still holds the turn's own text.
await destroyLive(B);
const refused = await api('POST', `/api/sessions/${batchSession}/undo-turn`, { callIds: batch.callIds });
check('undo-turn refuses the whole turn', refused.body?.status === 'refused', JSON.stringify(refused.body).slice(0, 600));
check('drift names the broken target', Array.isArray(refused.body?.drift) && refused.body.drift.some((line) => line.includes('MorphiE2EB')),
  JSON.stringify(refused.body?.drift));
check('nothing was written (restored is empty)', Array.isArray(refused.body?.restored) && refused.body.restored.length === 0);

const afterRefusal = await readLive(A);
check('untouched script A still holds the turn output (v2)', afterRefusal.ok && afterRefusal.source === A2, JSON.stringify(afterRefusal.source));

// Put the target back exactly as the turn left it, then the same batch must restore both in one call.
check('re-created script B at v2', await writeLive(B, B2), B2);
const batchUndo = await api('POST', `/api/sessions/${batchSession}/undo-turn`, { callIds: batch.callIds });
check('batch undo-turn 200', batchUndo.status === 200, JSON.stringify(batchUndo.body).slice(0, 400));
check('batch undo restored both checkpoints', batchUndo.body?.status === 'restored' && (batchUndo.body?.restored ?? []).length === 2,
  JSON.stringify(batchUndo.body).slice(0, 600));

const finalA = await readLive(A);
const finalB = await readLive(B);
check('both scripts back to v1', finalA.source === A1 && finalB.source === B1, `${JSON.stringify(finalA.source)} | ${JSON.stringify(finalB.source)}`);

// ---------------------------------------------------------------------------------------------
// Scenario 3 — a DELETE: the undo has to rebuild the instance from a pre-state capture
// ---------------------------------------------------------------------------------------------
console.log('\n[3] delete turn (execute_luau + Destroy)');
const modelPath = 'Workspace.MorphiE2EModel';

/** Create a Model with one Part and a Material, so the recreate has a subtree to rebuild. */
async function seedModel() {
  return withStudio(async (client) => {
    const code = 'local lib = "Workspace"\n'
      + 'local old = game:GetService(lib):FindFirstChild("MorphiE2EModel")\n'
      + 'if old ~= nil then old:Destroy() end\n'
      + 'local model = Instance.new("Model")\n'
      + 'model.Name = "MorphiE2EModel"\n'
      + 'local part = Instance.new("Part")\n'
      + 'part.Name = "Chunk"\n'
      + 'part.Material = Enum.Material.Plastic\n'
      + 'part.Anchored = true\n'
      + 'part.Parent = model\n'
      + 'model.Parent = game:GetService(lib)\n'
      + 'return "ok"';
    const result = await client.callTool({ name: 'execute_luau', arguments: { code, datamodel_type: 'Edit' } });
    return !result.isError;
  });
}

/** The model's shape as Studio reports it, for a before/after comparison. */
async function modelShape() {
  return withStudio(async (client) => {
    const code = 'local root = game:GetService("Workspace"):FindFirstChild("MorphiE2EModel")\n'
      + 'if root == nil then return "missing" end\n'
      + 'local names = {}\n'
      + 'for _, child in ipairs(root:GetChildren()) do table.insert(names, child.ClassName .. ":" .. child.Name) end\n'
      + 'return root.ClassName .. "|" .. table.concat(names, ",")';
    const result = await client.callTool({ name: 'execute_luau', arguments: { code, datamodel_type: 'Edit' } });
    return String(result.content?.find((part) => typeof part.text === 'string')?.text ?? '').trim();
  });
}

check('seed model with a Part', await seedModel(), modelPath);
const beforeShape = await modelShape();
check('model shape before the turn', beforeShape.startsWith('Model|Part:Chunk'), beforeShape);

const deleteSession = await newSession('e2e-delete-undo');
const deleteTurn = await turn(deleteSession, '/script studio-delete');
check('delete turn stream finished', deleteTurn.status === 200, `${deleteTurn.sse.length} bytes`);
check('model really destroyed by the turn', (await modelShape()) === 'missing', JSON.stringify(await modelShape()));

const del = await restorableCallIds(deleteSession);
check('delete checkpoint recorded as restorable', del.restorable.length === 1,
  `${del.restorable.length} restorable: ${del.callIds.join(', ')}`);
if (del.restorable.length === 0) console.log(JSON.stringify(del.rows, null, 2).slice(0, 2000));

const deleteUndo = await api('POST', `/api/sessions/${deleteSession}/undo-turn`, { callIds: del.callIds });
check('delete undo-turn 200', deleteUndo.status === 200, JSON.stringify(deleteUndo.body).slice(0, 400));
check('delete undo reported a restore', deleteUndo.body?.status === 'restored', JSON.stringify(deleteUndo.body).slice(0, 800));

const afterShape = await modelShape();
check('model recreated with its child', afterShape === beforeShape, `${JSON.stringify(afterShape)} vs ${JSON.stringify(beforeShape)}`);
check('nothing reported as skipped on the recreate', Array.isArray(deleteUndo.body?.skipped) && deleteUndo.body.skipped.length === 0,
  JSON.stringify(deleteUndo.body?.skipped));

// The undo must never rebuild over something that came back by hand.
await seedModel();
const secondUndo = await api('POST', `/api/sessions/${deleteSession}/undo-turn`, { callIds: del.callIds });
check('checkpoint is no longer restorable once restored', secondUndo.status >= 400 || secondUndo.body?.status !== 'restored',
  JSON.stringify(secondUndo.body).slice(0, 400));

// ---------------------------------------------------------------------------------------------
// Scenario 4 — a MOVE: the transform has no bag entry of its own, so the undo must rebuild it
// ---------------------------------------------------------------------------------------------
console.log('\n[4] move turn (execute_luau sets a CFrame)');
const partPath = 'Workspace.MorphiE2EPart';

async function seedPart() {
  return withStudio(async (client) => {
    const code = 'local ws = game:GetService("Workspace")\n'
      + 'local old = ws:FindFirstChild("MorphiE2EPart")\n'
      + 'if old ~= nil then old:Destroy() end\n'
      + 'local part = Instance.new("Part")\n'
      + 'part.Name = "MorphiE2EPart"\n'
      + 'part.Anchored = true\n'
      + 'part.Size = Vector3.new(4, 2, 1)\n'
      // A named rotation on purpose: a move that only translated would let a position-only restore pass.
      + 'part.CFrame = CFrame.new(10, 5, 0) * CFrame.Angles(math.rad(90), 0, 0)\n'
      + 'part.Parent = ws\n'
      + 'return "ok"';
    const result = await client.callTool({ name: 'execute_luau', arguments: { code, datamodel_type: 'Edit' } });
    return !result.isError;
  });
}

/** Position + the rotation matrix, which is what a restore has to reproduce exactly. */
async function partTransform() {
  return withStudio(async (client) => {
    const code = 'local part = game:GetService("Workspace"):FindFirstChild("MorphiE2EPart")\n'
      + 'if part == nil then return "missing" end\n'
      + 'local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = part.CFrame:GetComponents()\n'
      + 'return string.format("%.3f,%.3f,%.3f|%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f",'
      + ' x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22)';
    const result = await client.callTool({ name: 'execute_luau', arguments: { code, datamodel_type: 'Edit' } });
    return String(result.content?.find((part) => typeof part.text === 'string')?.text ?? '').trim();
  });
}

check('seed part with position and rotation', await seedPart(), partPath);
const beforeMove = await partTransform();
check('part starts at 10,5,0 rotated 90° about X', beforeMove.startsWith('10.000,5.000,0.000|'), beforeMove);

const moveSession = await newSession('e2e-move-undo');
const moveTurn = await turn(moveSession, '/script studio-move');
check('move turn stream finished', moveTurn.status === 200, `${moveTurn.sse.length} bytes`);
const afterMove = await partTransform();
check('part really moved by the turn', afterMove !== beforeMove && afterMove.startsWith('50.000,10.000,0.000|'), afterMove);

const moved = await restorableCallIds(moveSession);
check('move checkpoint recorded as restorable', moved.restorable.length === 1,
  `${moved.restorable.length} restorable: ${moved.callIds.join(', ')}`);
if (moved.restorable.length === 0) console.log(JSON.stringify(moved.rows, null, 2).slice(0, 2000));

const moveUndo = await api('POST', `/api/sessions/${moveSession}/undo-turn`, { callIds: moved.callIds });
check('move undo-turn 200', moveUndo.status === 200, JSON.stringify(moveUndo.body).slice(0, 400));
check('move undo reported a restore', moveUndo.body?.status === 'restored', JSON.stringify(moveUndo.body).slice(0, 600));
const movedBack = await partTransform();
check('part back at its exact old position AND rotation', movedBack === beforeMove, `${JSON.stringify(movedBack)} vs ${JSON.stringify(beforeMove)}`);

// Move it BY HAND to a third position, then the undo must refuse rather than overwrite.
await withStudio((client) => client.callTool({
  name: 'execute_luau',
  arguments: {
    code: 'local part = game:GetService("Workspace"):FindFirstChild("MorphiE2EPart")\n'
      + 'part.CFrame = CFrame.new(999, 0, 999)\nreturn "ok"',
    datamodel_type: 'Edit',
  },
}));
const handMoved = await partTransform();
check('part hand-moved to a third position', handMoved.startsWith('999.000,0.000,999.000|'), handMoved);
const afterFirstUndo = await api('POST', `/api/sessions/${moveSession}/undo-turn`, { callIds: moved.callIds });
check('an already-restored turn is not restorable again', afterFirstUndo.body?.status !== 'restored',
  JSON.stringify(afterFirstUndo.body).slice(0, 400));
check('the hand move survived', (await partTransform()) === handMoved, await partTransform());

// ---------------------------------------------------------------------------------------------
// Scenario 5 — a RENAME + REPARENT: neither value is in the property bag
// ---------------------------------------------------------------------------------------------
console.log('\n[5] rename/reparent turn');

/** name + parent path, exactly what the undo has to put back. */
async function identityOf(name) {
  return withStudio(async (client) => {
    // Recursive: after the reparent the instance lives inside a folder, not directly in Workspace.
    const code = 'local root = game:GetService("Workspace"):FindFirstChild(' + JSON.stringify(name) + ', true)\n'
      + 'if root == nil then return "missing" end\n'
      + 'return root.Name .. "|" .. root.Parent:GetFullName()';
    const result = await client.callTool({ name: 'execute_luau', arguments: { code, datamodel_type: 'Edit' } });
    return String(result.content?.find((part) => typeof part.text === 'string')?.text ?? '').trim();
  });
}

async function seedFolderAndPart() {
  return withStudio((client) => client.callTool({
    name: 'execute_luau',
    arguments: {
      code: 'local ws = game:GetService("Workspace")' + '\n'
        + 'local oldPart = ws:FindFirstChild("MorphiE2EPart")' + '\n'
        + 'if oldPart ~= nil then oldPart:Destroy() end' + '\n'
        + 'local oldRenamed = ws:FindFirstChild("MorphiE2ERenamed")' + '\n'
        + 'if oldRenamed ~= nil then oldRenamed:Destroy() end' + '\n'
        + 'local oldFolder = ws:FindFirstChild("MorphiE2EFolder")' + '\n'
        + 'if oldFolder ~= nil then oldFolder:Destroy() end' + '\n'
        + 'local folder = Instance.new("Folder")' + '\n'
        + 'folder.Name = "MorphiE2EFolder"' + '\n'
        + 'folder.Parent = ws' + '\n'
        + 'local part = Instance.new("Part")' + '\n'
        + 'part.Name = "MorphiE2EPart"' + '\n'
        + 'part.Anchored = true' + '\n'
        + 'part.Parent = ws' + '\n'
        + 'return "ok"',
      datamodel_type: 'Edit',
    },
  }));
}

await seedFolderAndPart();
const beforeIdentity = await identityOf('MorphiE2EPart');
check('part starts at Workspace with its own name', beforeIdentity === 'MorphiE2EPart|Workspace', beforeIdentity);

const renameSession = await newSession('e2e-rename-undo');
const renameTurn = await turn(renameSession, '/script studio-rename');
check('rename turn stream finished', renameTurn.status === 200, `${renameTurn.sse.length} bytes`);
check('part really moved and renamed by the turn', (await identityOf('MorphiE2ERenamed')) === 'MorphiE2ERenamed|Workspace.MorphiE2EFolder',
  await identityOf('MorphiE2ERenamed'));
check('the old path is gone', (await identityOf('MorphiE2EPart')) === 'missing', await identityOf('MorphiE2EPart'));

const renamed = await restorableCallIds(renameSession);
check('rename checkpoint recorded as restorable', renamed.restorable.length === 1,
  `${renamed.restorable.length} restorable: ${renamed.callIds.join(', ')}`);
if (renamed.restorable.length === 0) console.log(JSON.stringify(renamed.rows, null, 2).slice(0, 2000));

const renameUndo = await api('POST', `/api/sessions/${renameSession}/undo-turn`, { callIds: renamed.callIds });
check('rename undo-turn 200', renameUndo.status === 200, JSON.stringify(renameUndo.body).slice(0, 400));
check('rename undo reported a restore', renameUndo.body?.status === 'restored', JSON.stringify(renameUndo.body).slice(0, 700));
const backIdentity = await identityOf('MorphiE2EPart');
check('part back at Workspace with its old name', backIdentity === 'MorphiE2EPart|Workspace', backIdentity);

// Reparenting it by hand afterwards must not be undone on top of the user's choice.
await withStudio((client) => client.callTool({
  name: 'execute_luau',
  arguments: {
    code: 'local part = game:GetService("Workspace"):FindFirstChild("MorphiE2EPart")'
      + '\n'
      + 'part.Parent = game:GetService("ServerStorage")'
      + '\n'
      + 'return "ok"',
    datamodel_type: 'Edit',
  },
}));
const handParent = await withStudio(async (client) => {
  const result = await client.callTool({
    name: 'execute_luau',
    arguments: {
      code: 'local p = game:GetService("ServerStorage"):FindFirstChild("MorphiE2EPart")'
        + '\n'
        + 'return p == nil and "missing" or "ServerStorage"',
      datamodel_type: 'Edit',
    },
  });
  return String(result.content?.find((part) => typeof part.text === 'string')?.text ?? '').trim();
});
check('part hand-reparented into ServerStorage', handParent === 'ServerStorage', handParent);

// ---------------------------------------------------------------------------------------------
// Scenario 6 — an INSERT: the instance only exists because the turn made it
// ---------------------------------------------------------------------------------------------
console.log('\n[6] insert turn');

/** Does a path resolve right now? `missing` also covers a path the launcher cannot walk. */
async function existsAt(path) {
  const segments = path.split('.');
  const literal = '{' + segments.map((segment) => JSON.stringify(segment)).join(', ') + '}';
  return withStudio(async (client) => {
    const code = 'local segs = ' + literal + '\n'
      + 'local root = game:GetService(segs[1])\n'
      + 'for i = 2, #segs do\n'
      + '  if root == nil then break end\n'
      + '  root = root:FindFirstChild(segs[i])\n'
      + 'end\n'
      + 'return root == nil and "missing" or "exists"';
    const result = await client.callTool({ name: 'execute_luau', arguments: { code, datamodel_type: 'Edit' } });
    return String(result.content?.find((part) => typeof part.text === 'string')?.text ?? '').trim();
  });
}

// A leftover from an earlier run would make the diff believe the instance already existed.
await destroyLive('Workspace.MorphiE2ECreated');
check('nothing named MorphiE2ECreated before the turn', (await existsAt('Workspace.MorphiE2ECreated')) === 'missing');

const insertSession = await newSession('e2e-insert-undo');
const insertTurn = await turn(insertSession, '/script studio-created');
check('insert turn stream finished', insertTurn.status === 200, `${insertTurn.sse.length} bytes`);
check('the turn really created the part', (await existsAt('Workspace.MorphiE2ECreated')) === 'exists');

const inserted = await restorableCallIds(insertSession);
check('insert checkpoint recorded as restorable', inserted.restorable.length === 1,
  `${inserted.restorable.length} restorable: ${inserted.callIds.join(', ')}`);
if (inserted.restorable.length === 0) console.log(JSON.stringify(inserted.rows, null, 2).slice(0, 2000));

const insertUndo = await api('POST', `/api/sessions/${insertSession}/undo-turn`, { callIds: inserted.callIds });
check('insert undo-turn 200', insertUndo.status === 200, JSON.stringify(insertUndo.body).slice(0, 400));
check('insert undo reported a restore', insertUndo.body?.status === 'restored', JSON.stringify(insertUndo.body).slice(0, 700));
check('the created part is gone after the undo', (await existsAt('Workspace.MorphiE2ECreated')) === 'missing');
check('the place still has its own script', (await existsAt(A)) === 'exists');

// ---------------------------------------------------------------------------------------------
// Cleanup — the place must not keep probe fixtures
// ---------------------------------------------------------------------------------------------
await destroyLive(A);
await destroyLive(B);
await destroyLive(modelPath);
await destroyLive(partPath);
// The rename scenario leaves three fixtures: the renamed part, the folder it was moved into, and
// (after the hand-reparent) a part in ServerStorage. `destroyLive` resolves the service by name, so
// each of them goes with its own path.
await destroyLive('Workspace.MorphiE2ERenamed');
await destroyLive('Workspace.MorphiE2EFolder');
await destroyLive('ServerStorage.MorphiE2EPart');
const goneA = await readLive(A);
const goneB = await readLive(B);
check('probe scripts removed from the place', !goneA.ok && !goneB.ok);
check('probe model removed from the place', (await modelShape()) === 'missing');
check('probe part removed from the place', (await partTransform()) === 'missing');
check('probe folder and renamed part removed', (await identityOf('MorphiE2ERenamed')) === 'missing'
  && (await identityOf('MorphiE2EFolder')) === 'missing');

console.log(failures === 0 ? '\nE2E OK' : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
