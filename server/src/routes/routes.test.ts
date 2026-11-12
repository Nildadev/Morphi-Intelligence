import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test/db';
import { createApp } from '../app';
import type { SessionEvent } from '../harness/events/types';
import { createHarness, type Harness, type McpStatus } from '../harness/harness';
import { LlmRegistry } from '../harness/llm/registry';
import { createProviderSettingsStore } from '../harness/llm/settings';
import { createMcpGateway, createMcpLog, mcpStatusOf, isAllowedMcpPath } from '../harness/mcp/serviceGateway';
import type { McpBridge } from '../harness/mcp/serviceGateway';
import type { ToolSchema } from '../harness/llm/types';
import type { ModelInfo, ProviderAdapter, LlmRequest, StreamEvent } from '../harness/llm/types';
import type { McpGateway, McpSource } from '../harness/tools/types';
import { mountRoutes } from './index';

const TOKEN = 'test-token';
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-routes-'));
  tempDirs.push(dir);
  return dir;
}

function model(id: string, provider: string): ModelInfo {
  return { id, name: id, provider, providerLabel: provider, context: 128_000, supportsTools: true };
}

class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  models: ModelInfo[];
  apiKey = '';
  baseUrl = '';
  listModelsCalls = 0;

  constructor(id: string, models: ModelInfo[]) {
    this.id = id;
    this.name = id;
    this.models = models;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.listModelsCalls += 1;
    return this.models;
  }

  async *stream(_request: LlmRequest): AsyncIterable<StreamEvent> {
    yield { type: 'finish', reason: 'stop' } satisfies StreamEvent;
  }
}

/** Route tests only need the Task 14 surface; the stub mirrors what the real gateway can vouch for. */
class StubGateway implements McpGateway {
  connected = false;
  studioLinked = false;
  // Task 31C: the status body reads these three, so a stub that omits them would report a shape
  // production never produces.
  studio: { id: string; name: string } | null = null;
  toolCount = 0;
  lastError: { code: string; message: string } | null = null;
  reconnects = 0;
  logs: string[] = [];
  calls: Array<{ name: string; args: unknown }> = [];
  tools: ToolSchema[] = [{ name: 'script_read', description: 'Read a script.', parameters: { type: 'object' } }];
  /** Set only by a bridge that can name its own process, exactly like Task 31's resolver will. */
  serverInfo?: { source: McpSource; path: string | null; version: string | null };

  get server(): { source: McpSource; path: string | null; version: string | null } {
    // A stored path override is not a connected server: report `none` until something names itself.
    return this.serverInfo ?? { source: 'none', path: null, version: null };
  }

  listCalls = 0;

  async listTools(): Promise<ToolSchema[]> {
    this.listCalls += 1;
    return this.tools;
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args });
    return { ok: true, name };
  }

  async reconnect(): Promise<void> {
    this.reconnects += 1;
    this.connected = true;
    this.logs.push('MCP reconnect requested');
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  /** `syncTools()` only asks a connected gateway for its tools, so a test opens the link first. */
  async connect(): Promise<void> {
    this.connected = true;
  }
}

/** Stub used to prove `mcpStatusOf` cannot invent an identity the bridge did not report. */
class LegacyStubBridge implements McpBridge {
  connected = false;
  studioLinked = false;
  serverInfo: { source: McpSource; path: string | null; version: string | null } = {
    source: 'none', path: null, version: null,
  };

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.studioLinked = false;
  }

  async listTools(): Promise<{ tools?: unknown }> {
    return { tools: [] };
  }

  async callTool(): Promise<unknown> {
    return { content: [] };
  }
}

interface TestHarness {
  harness: Harness;
  mcp: StubGateway;
  llm: LlmRegistry;
  adapter: FakeAdapter;
}

function buildHarness(): TestHarness {
  const db = createTestDb();
  const adapter = new FakeAdapter('fake', [model('fake-tools', 'fake')]);
  const llm = new LlmRegistry([adapter], ['fake']);
  const providerSettings = createProviderSettingsStore(db);
  const mcp = new StubGateway();
  const harness = createHarness({
    db,
    llm,
    mcp,
    titleModel: 'auto',
    providerSettings,
    compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
  });
  return { harness, mcp, llm, adapter };
}

function buildApp(harness: Harness): Express {
  return createApp({ token: TOKEN, version: '1.1.0', mount: (app) => mountRoutes(app, harness) });
}

function api(app: Express): { get(url: string): request.Test; post(url: string): request.Test; put(url: string): request.Test; del(url: string): request.Test } {
  const withToken = <T extends request.Test>(call: T): T => call.set('X-Morphi-Token', TOKEN);
  return {
    get: (url) => withToken(request(app).get(url)),
    post: (url) => withToken(request(app).post(url)),
    put: (url) => withToken(request(app).put(url)),
    del: (url) => withToken(request(app).delete(url)),
  };
}

async function createProject(app: Express, name = 'Wave Spawner'): Promise<{ id: string }> {
  const res = await api(app).post('/api/projects').send({ name });
  expect(res.status).toBe(201);
  return res.body;
}

async function createSession(app: Express, projectId: string, title = 'Spawn test'): Promise<{ id: string; projectName?: string; title?: string }> {
  const res = await api(app).post('/api/sessions').send({ projectId, title });
  expect(res.status).toBe(201);
  return res.body;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('route authentication', () => {
  it('serves health without a token and every data route with 401', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);

    expect((await request(app).get('/api/health')).status).toBe(200);

    const protectedRoutes: Array<[string, 'get' | 'post' | 'put' | 'del']> = [
      ['/api/projects', 'get'],
      ['/api/projects', 'post'],
      ['/api/sessions', 'get'],
      ['/api/sessions/sess_1', 'get'],
      ['/api/sessions/sess_1/events', 'get'],
      ['/api/sessions/sess_1/pin', 'post'],
      ['/api/sessions/sess_1', 'del'],
      ['/api/sessions/sess_1/tools/todo_write', 'post'],
      ['/api/providers', 'get'],
      ['/api/providers/fake/config', 'put'],
      ['/api/models', 'get'],
      ['/api/tools', 'get'],
      ['/api/mcp/status', 'get'],
      ['/api/mcp/reconnect', 'post'],
      ['/api/mcp/path', 'put'],
      ['/api/memory/stats', 'get'],
      ['/api/memory', 'del'],
      ['/api/chat/stream', 'post'],
      ['/api/chat/cancel', 'post'],
      ['/api/chat/regenerate', 'post'],
      ['/api/approvals/ap_1', 'post'],
    ];

    for (const [url, method] of protectedRoutes) {
      const res = await request(app)[method === 'del' ? 'delete' : method](url);
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body, `${method} ${url}`).toEqual({ error: { code: 'UNAUTHORIZED' } });
    }
  });
});

describe('projects routes', () => {
  it('creates, lists and deletes a project with its sessions', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);

    const created = await createProject(app, 'Tower Defense');
    expect(created).toMatchObject({ name: 'Tower Defense' });
    expect(created.id).toMatch(/^proj_/);

    const session = await createSession(app, created.id);
    const list = await api(app).get('/api/projects');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toEqual({
      id: created.id,
      name: 'Tower Defense',
      description: undefined,
      createdAt: expect.any(Number),
      lastActive: expect.any(Number),
    });

    const removed = await api(app).del(`/api/projects/${created.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, id: created.id });
    expect(harness.projects.list()).toEqual([]);
    expect(harness.sessions.list()).toEqual([]);
  });

  it('validates the create body and answers 404 for an unknown project', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);

    const invalid = await api(app).post('/api/projects').send({ description: 'no name' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const missing = await api(app).del('/api/projects/proj_missing');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('sessions routes', () => {
  it('lists summaries without messages and details with derived ones', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id, 'DataStore test');
    // The create response must carry the same fields the list does, or Task 19 has to re-fetch a
    // session it just made to render its own title row.
    expect(session).toMatchObject({ id: expect.any(String), projectId: project.id, projectName: 'Wave Spawner', title: 'DataStore test' });

    harness.events.append(session.id, [
      { type: 'user/message', payload: { messageId: 'msg_u1', content: 'Viết script leaderstats', source: 'user' } },
      {
        type: 'assistant/message',
        payload: { messageId: 'msg_a1', content: 'Xong.', finishReason: 'stop', callIds: [] },
      },
    ]);

    const list = await api(app).get(`/api/sessions?projectId=${project.id}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty('messages');
    expect(list.body[0]).toMatchObject({
      id: session.id,
      projectId: project.id,
      projectName: 'Wave Spawner',
      title: 'DataStore test',
      isPinned: false,
      status: 'idle',
    });

    const detail = await api(app).get(`/api/sessions/${session.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.skills).toEqual([]);
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.messages[0]).toMatchObject({ id: 'msg_u1', role: 'user', content: 'Viết script leaderstats' });
    expect(detail.body.messages[1]).toMatchObject({ id: 'msg_a1', role: 'assistant', content: 'Xong.' });
  });

  it('hides a session from the public list until its first user or assistant message', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id, 'Chưa nói gì');

    // Created but never messaged: a "new chat" row must not clutter the sidebar.
    expect((await api(app).get(`/api/sessions?projectId=${project.id}`)).body).toEqual([]);

    harness.events.append(session.id, [
      { type: 'turn/start', payload: { turnId: 'turn_1', modelSelection: 'auto', trigger: 'user' } },
    ]);
    // Control events alone still do not make it visible.
    expect((await api(app).get(`/api/sessions?projectId=${project.id}`)).body).toEqual([]);

    harness.events.append(session.id, [
      { type: 'user/message', payload: { messageId: 'msg_u1', content: 'xin chào', source: 'user' } },
    ]);
    const list = await api(app).get(`/api/sessions?projectId=${project.id}`);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([session.id]);
  });

  it('lists workspace checkpoints for a session, newest first, and 404s an unknown session', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);

    const empty = await api(app).get(`/api/sessions/${session.id}/checkpoints`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    harness.checkpoints.record({
      sessionId: session.id,
      label: 'Sửa nhiều đoạn script · studio.multi_edit',
      manifest: {
        tool: 'studio.multi_edit',
        callId: 'c1',
        argsHash: 'deadbeef',
        targets: ['ServerScriptService/Main'],
        outcome: 'ok',
        preState: null,
        restorable: false,
        restoreReason: 'no inverse',
      },
    });

    const listed = await api(app).get(`/api/sessions/${session.id}/checkpoints`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      sessionId: session.id,
      label: 'Sửa nhiều đoạn script · studio.multi_edit',
      rootHash: expect.any(String),
      manifest: { tool: 'studio.multi_edit', restorable: false },
    });

    const missing = await api(app).get('/api/sessions/nope/checkpoints');
    expect(missing.status).toBe(404);
  });

  it('previews and applies a restore, and refuses one that cannot be undone', async () => {
    const { harness, mcp } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);

    // A restorable checkpoint: the pre-state holds the OLD source, the inverse writes it back.
    const restorable = harness.checkpoints.record({
      sessionId: session.id,
      label: 'Ghi script · studio.write_script',
      manifest: {
        tool: 'studio.write_script',
        callId: 'c1',
        argsHash: 'h1',
        targets: ['A'],
        outcome: 'ok',
        preState: {
          entries: [{ kind: 'script', path: 'A', source: 'old' }],
          inverse: [{ tool: 'script_write', path: 'A', source: 'old' }],
          notes: [],
        },
        restorable: true,
        restoreReason: 'ok',
      },
    });
    // A non-restorable one: an audit record with no inverse.
    const auditOnly = harness.checkpoints.record({
      sessionId: session.id,
      label: 'Sửa nhiều đoạn script · studio.multi_edit',
      manifest: {
        tool: 'studio.multi_edit',
        callId: 'c2',
        argsHash: 'h2',
        targets: ['B'],
        outcome: 'ok',
        preState: null,
        restorable: false,
        restoreReason: 'Chưa chụp được snapshot trước khi sửa.',
      },
    });

    // Studio is not linked in this stub, so the engine refuses before reading anything.
    const offline = await api(app).get(`/api/sessions/${session.id}/checkpoints/${restorable.id}/restore`);
    expect(offline.status).toBe(409);
    expect(offline.body).toMatchObject({ error: { code: 'STUDIO_NOT_CONNECTED' } });

    mcp.connected = true;
    mcp.studioLinked = true;
    mcp.tools = [
      { name: 'studio.script_read', description: 'read', parameters: { type: 'object' } },
      { name: 'studio.write_script', description: 'write', parameters: { type: 'object' } },
    ];
    // The live source differs from the snapshot, so there is something to restore. The write
    // actually changes what a later read returns — otherwise the engine's read-back verification
    // (correctly) refuses to call the restore a success.
    let live = 'new';
    mcp.calls = [];
    mcp.callTool = async (name: string, args: unknown) => {
      mcp.calls.push({ name, args });
      if (name === 'studio.script_read') return live;
      live = (args as { source: string }).source;
      return { ok: true };
    };

    const preview = await api(app).get(`/api/sessions/${session.id}/checkpoints/${restorable.id}/restore`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      clean: true,
      steps: [{ path: 'A', action: 'restore-script' }],
    });

    const applied = await api(app).post(`/api/sessions/${session.id}/checkpoints/${restorable.id}/restore`);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ status: 'restored', applied: 1, failed: [] });
    expect(harness.checkpoints.get(restorable.id)?.status).toBe('restored');
    expect(mcp.calls).toContainEqual({ name: 'studio.write_script', args: { path: 'A', source: 'old' } });

    // An audit-only checkpoint is refused by its own reason, not attempted.
    const refused = await api(app).get(`/api/sessions/${session.id}/checkpoints/${auditOnly.id}/restore`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'NOT_RESTORABLE' } });

    // A checkpoint from another session is a 404, never a cross-session restore.
    const other = await createSession(app, project.id);
    const foreign = await api(app).get(`/api/sessions/${other.id}/checkpoints/${restorable.id}/restore`);
    expect(foreign.status).toBe(404);
  });

  it('undoes a whole turn from its call ids, and validates the body', async () => {
    const { harness, mcp } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);

    harness.checkpoints.record({
      sessionId: session.id,
      label: 'turn undo',
      manifest: {
        tool: 'studio.write_script',
        callId: 'call_1',
        argsHash: 'h',
        targets: ['A'],
        outcome: 'ok',
        preState: {
          entries: [{ kind: 'script', path: 'A', source: 'old' }],
          inverse: [{ tool: 'script_write', path: 'A', source: 'old' }],
          notes: [],
        },
        restorable: true,
        restoreReason: 'ok',
      },
    });

    mcp.connected = true;
    mcp.studioLinked = true;
    mcp.tools = [
      { name: 'studio.script_read', description: 'read', parameters: { type: 'object' } },
      { name: 'studio.write_script', description: 'write', parameters: { type: 'object' } },
    ];
    let live = 'new';
    mcp.callTool = async (name: string, args: unknown) => {
      if (name === 'studio.script_read') return live;
      live = (args as { source: string }).source;
      return { ok: true };
    };

    const restored = await api(app).post(`/api/sessions/${session.id}/undo-turn`).send({ callIds: ['call_1'] });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ status: 'restored', drift: [] });
    expect(restored.body.restored).toHaveLength(1);

    // An empty list is a 400, not a silent no-op.
    const empty = await api(app).post(`/api/sessions/${session.id}/undo-turn`).send({ callIds: [] });
    expect(empty.status).toBe(400);

    // Call ids that match nothing answer 409 with the reason instead of pretending.
    const none = await api(app).post(`/api/sessions/${session.id}/undo-turn`).send({ callIds: ['nope'] });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: { code: 'NOTHING_TO_RESTORE' } });
  });

  it('replays events after a sequence number', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);

    const first = await api(app).get(`/api/sessions/${session.id}/events`);
    expect(first.status).toBe(200);
    expect(first.body.sessionId).toBe(session.id);
    expect(first.body.events.map((event: SessionEvent) => event.type)).toEqual(['session/created']);
    expect(first.body.lastSeq).toBe(1);

    harness.events.append(session.id, [
      { type: 'turn/start', payload: { turnId: 'turn_1', modelSelection: 'auto', trigger: 'user' } },
    ]);
    const after = await api(app).get(`/api/sessions/${session.id}/events?after=1`);
    expect(after.body.events).toHaveLength(1);
    expect(after.body.events[0]).toMatchObject({ seq: 2, type: 'turn/start', schemaVersion: 1 });
    expect(after.body.lastSeq).toBe(2);

    const invalid = await api(app).get(`/api/sessions/${session.id}/events?after=-1`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    // The full log, not a projection of it: `after=0` still answers from the first sequence number.
    harness.events.append(session.id, [
      { type: 'step/start', payload: { stepId: 'step_1', index: 0 } },
      { type: 'assistant/message', payload: { messageId: 'msg_a1', content: 'Xong.', finishReason: 'stop', callIds: [] } },
    ]);
    const full = await api(app).get(`/api/sessions/${session.id}/events`);
    expect(full.body.events.map((event: SessionEvent) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(full.body.events.map((event: SessionEvent) => event.type)).toEqual([
      'session/created',
      'turn/start',
      'step/start',
      'assistant/message',
    ]);
    expect(full.body.lastSeq).toBe(4);
  });

  it('probes existence instead of projecting the log on the cheap routes', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);
    harness.events.append(session.id, [
      { type: 'turn/start', payload: { turnId: 'turn_1', modelSelection: 'auto', trigger: 'user' } },
    ]);

    const detail = vi.spyOn(harness.sessions, 'get');
    const projectList = vi.spyOn(harness.projects, 'list');
    const eventList = vi.spyOn(harness.events, 'list');
    try {
      expect((await api(app).get(`/api/sessions/${session.id}/events`)).status).toBe(200);
      expect((await api(app).post(`/api/sessions/${session.id}/tools/lint_luau`).send({ enabled: false })).status).toBe(200);
      expect((await api(app).del(`/api/sessions/${session.id}`)).status).toBe(200);
      // The replay route must read the log exactly once and no route may project it for a 404:
      // `sessions.get()` used to replay and derive the whole log just to learn the row exists.
      expect(eventList).toHaveBeenCalledTimes(1);
      expect(detail).not.toHaveBeenCalled();

      // Session create and project delete check the row by id instead of scanning the table.
      expect((await api(app).post('/api/sessions').send({ projectId: project.id })).status).toBe(201);
      expect((await api(app).del(`/api/projects/${project.id}`)).status).toBe(200);
      expect(projectList).not.toHaveBeenCalled();
    } finally {
      detail.mockRestore();
      projectList.mockRestore();
      eventList.mockRestore();
    }

    // Same 404s as before: the probe answers, it does not soften the contract.
    const missingSession = await api(app).get('/api/sessions/sess_missing/events');
    expect(missingSession.status).toBe(404);
    expect(missingSession.body.error.code).toBe('SESSION_NOT_FOUND');
    const missingProject = await api(app).del('/api/projects/proj_missing');
    expect(missingProject.status).toBe(404);
    expect(missingProject.body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('rejects a session body without a known project and 404s an unknown session', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);

    const orphan = await api(app).post('/api/sessions').send({ projectId: 'proj_missing' });
    expect(orphan.status).toBe(404);
    expect(orphan.body.error.code).toBe('PROJECT_NOT_FOUND');

    const detail = await api(app).get('/api/sessions/sess_missing');
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('pins, un-pins and deletes a session', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const first = await createSession(app, project.id, 'First');
    const second = await createSession(app, project.id, 'Second');
    // The public list only shows sessions that already carry a message.
    for (const session of [first, second]) {
      harness.events.append(session.id, [
        { type: 'user/message', payload: { messageId: `msg_${session.id}`, content: 'hi', source: 'user' } },
      ]);
    }

    const pinned = await api(app).post(`/api/sessions/${first.id}/pin`).send({ pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body).toEqual({ id: first.id, isPinned: true });

    const toggled = await api(app).post(`/api/sessions/${first.id}/pin`).send({});
    expect(toggled.body).toEqual({ id: first.id, isPinned: false });

    const order = await api(app).get('/api/sessions');
    expect(order.body.map((session: { id: string }) => session.id)).toEqual([second.id, first.id]);

    const removed = await api(app).del(`/api/sessions/${first.id}`);
    expect(removed.body).toEqual({ ok: true, id: first.id });
    expect(harness.sessions.list()).toHaveLength(1);
  });

  it('undo-message appends a revert and returns the shortened projection', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id, 'Chat');
    harness.events.append(session.id, [
      { type: 'user/message', payload: { messageId: 'u1', content: 'old', source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'a1', content: 'old answer', finishReason: 'stop', callIds: [] } },
      { type: 'user/message', payload: { messageId: 'u2', content: 'undo me', source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'a2', content: 'answer to undo', finishReason: 'stop', callIds: [] } },
    ]);

    const res = await api(app).post(`/api/sessions/${session.id}/undo-message`).send({ messageId: 'u2' });

    expect(res.status).toBe(200);
    expect(res.body.messages.map((message: { id: string }) => message.id)).toEqual(['u1', 'a1']);
    expect(harness.events.list(session.id).at(-1)?.type).toBe('session/revert');
  });

  it('branches a session prefix into a new checkout session', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id, 'Chat');
    harness.events.append(session.id, [
      { type: 'user/message', payload: { messageId: 'u1', content: 'old', source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'a1', content: 'old answer', finishReason: 'stop', callIds: [] } },
      { type: 'user/message', payload: { messageId: 'u2', content: 'keep all', source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'a2', content: 'new answer', finishReason: 'stop', callIds: [] } },
    ]);

    const res = await api(app).post(`/api/sessions/${session.id}/branch`).send({ toSeq: 3 });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(session.id);
    expect(res.body.title).toContain('branch');
    expect(res.body.messages.map((message: { id: string }) => message.id)).toEqual(['u1', 'a1']);
    expect(harness.sessions.get(session.id)?.messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});

describe('providers routes', () => {
  it('lists built-in status with the persisted base url and updates config only', async () => {
    const { harness, llm, adapter } = buildHarness();
    const app = buildApp(harness);
    llm.setCredentials({ fake: 'sk-fake' });

    const list = await api(app).get('/api/providers');
    expect(list.body).toEqual([
      { providerId: 'fake', configured: true, enabled: true, baseUrl: null, custom: false, keyless: false },
    ]);
    expect(JSON.stringify(list.body)).not.toContain('sk-fake');

    const updated = await api(app).put('/api/providers/fake/config').send({ enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      providerId: 'fake',
      configured: true,
      enabled: false,
      baseUrl: null,
      custom: false,
      keyless: false,
    });
    expect(harness.providerSettings.get('fake')).toMatchObject({ enabled: false, updatedAt: expect.any(Number) });
    expect(llm.providerStatus()).toEqual([{ providerId: 'fake', configured: true, enabled: false, keyless: false }]);
    expect(adapter.baseUrl).toBe('');
  });

  it('rejects a connect for a provider that has no account to connect', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);

    const res = await api(app).get('/api/providers/not-a-bridge/bridge');
    expect(res.status).toBe(404);
    const connected = await api(app).post('/api/providers/not-a-bridge/connect');
    expect(connected.status).toBe(404);
  });

  it('reports an unreachable bridge as unreachable and never speaks for the account', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = await api(app).get('/api/providers/deepseek-chat/bridge');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'unreachable', baseUrl: 'http://127.0.0.1:8000/v1' });
      // Health check only: a `chat/completions` request here would spend the account's rate limit
      // on a liveness question. `/healthz` sits at the server root — the `/v1` prefix is stripped.
      expect(fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual(['http://127.0.0.1:8000/healthz']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('connects the keyless provider through the bridge and refreshes the model list', async () => {
    const { harness, llm } = buildHarness();
    const app = buildApp(harness);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/healthz')) return Response.json({ status: 'ok' });
      return Response.json({ choices: [{ message: { content: 'hi' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.spyOn(llm, 'refreshModels');

    try {
      const res = await api(app).post('/api/providers/deepseek-chat/connect').send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'connected', message: expect.stringContaining('Đã kết nối tài khoản') });
      // A fresh session must show up in the picker, or the row would claim what the app cannot use.
      expect(refresh).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects an api key in the body with 400 and never stores it', async () => {
    const { harness, adapter } = buildHarness();
    const app = buildApp(harness);

    const res = await api(app).put('/api/providers/fake/config').send({ apiKey: 'sk-live-secret' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_KEY_NOT_ACCEPTED');
    expect(adapter.apiKey).toBe('');
    expect(harness.providerSettings.get('fake')).toBeUndefined();

    const unknownKey = await api(app).put('/api/providers/fake/config').send({ baseUrl: 'https://example.test/v1', key: 'nope' });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a base URL for a built-in provider so a stored key cannot be redirected', async () => {
    const { harness, adapter } = buildHarness();
    const app = buildApp(harness);

    // The built-in adapters talk to their own fixed endpoints in 1.1.0; accepting a base URL here
    // would send the `safeStorage` key as a bearer token to whatever host the caller named.
    const res = await api(app).put('/api/providers/fake/config').send({ baseUrl: 'https://collector.test/v1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(adapter.baseUrl).toBe('');
    expect(harness.providerSettings.get('fake')).toBeUndefined();

    const enabledOnly = await api(app).put('/api/providers/fake/config').send({ enabled: false });
    expect(enabledOnly.status).toBe(200);

    const mixed = await api(app).put('/api/providers/fake/config').send({ baseUrl: 'https://collector.test/v1', enabled: true });
    expect(mixed.status).toBe(400);
    expect(harness.providerSettings.get('fake')).toMatchObject({ enabled: false });
  });

  it('keeps a base URL configurable for custom connectors, on create and on update', async () => {
    const { harness, llm } = buildHarness();
    const app = buildApp(harness);

    const created = await api(app).put('/api/providers/custom:local-llama/config').send({ baseUrl: 'http://127.0.0.1:1/v1' });
    expect(created.status).toBe(200);
    expect(created.body.baseUrl).toBe('http://127.0.0.1:1/v1');

    const moved = await api(app).put('/api/providers/custom:local-llama/config').send({ baseUrl: 'http://127.0.0.2:1/v1' });
    expect(moved.status).toBe(200);
    expect(moved.body.baseUrl).toBe('http://127.0.0.2:1/v1');
    expect(harness.providerSettings.get('custom:local-llama')?.baseUrl).toBe('http://127.0.0.2:1/v1');
    expect(llm.providerStatus().map((provider) => provider.providerId)).toContain('custom:local-llama');
  });

  it('registers a new custom provider and refreshes models', async () => {
    const { harness, llm } = buildHarness();
    const app = buildApp(harness);

    const created = await api(app)
      .put('/api/providers/custom:my-llm/config')
      .send({ baseUrl: 'http://127.0.0.1:1/v1', enabled: true });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({
      providerId: 'custom:my-llm',
      configured: false,
      enabled: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      custom: true,
      keyless: false,
    });
    expect(harness.providerSettings.get('custom:my-llm')?.baseUrl).toBe('http://127.0.0.1:1/v1');
    expect(llm.providerStatus().map((provider) => provider.providerId)).toEqual(['fake', 'custom:my-llm']);

    const list = await api(app).get('/api/providers');
    expect(list.body).toHaveLength(2);

    const badId = await api(app).put('/api/providers/Custom_Bad/config').send({ enabled: false });
    expect(badId.status).toBe(404);
    expect(badId.body.error.code).toBe('UNKNOWN_PROVIDER');

    const noBaseUrl = await api(app).put('/api/providers/custom:other/config').send({ enabled: true });
    expect(noBaseUrl.status).toBe(400);
    expect(noBaseUrl.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('models routes', () => {
  it('is empty with no configured provider and lists usable models otherwise', async () => {
    const { harness, llm } = buildHarness();
    const app = buildApp(harness);

    expect((await api(app).get('/api/models?usable=true')).body).toEqual([]);

    llm.setCredentials({ fake: 'sk-fake' });
    await llm.refreshModels();
    const res = await api(app).get('/api/models?usable=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 'fake-tools',
        name: 'fake-tools',
        provider: 'fake',
        providerLabel: 'fake',
        context: 128_000,
        supportsTools: true,
      },
    ]);
  });

  it('validates the usable flag instead of guessing', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const res = await api(app).get('/api/models?usable=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('tools routes', () => {
  it('exposes metadata without the execute body and mirrors mcp tools', async () => {
    const { harness, mcp } = buildHarness();
    const app = buildApp(harness);
    await mcp.connect();
    await harness.syncTools();

    const res = await api(app).get('/api/tools');
    expect(res.status).toBe(200);
    const names = res.body.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['todo_write', 'lint_luau', 'studio.script_read']));
    for (const tool of res.body) {
      expect(Object.keys(tool).sort()).toEqual([
        'approval',
        'concurrencySafe',
        'description',
        'enabled',
        'label',
        'name',
        'risk',
      ]);
    }
    expect(res.body.find((tool: { name: string }) => tool.name === 'studio.script_read')).toMatchObject({
      approval: 'auto',
      risk: 'low',
      enabled: true,
    });
  });

  it('toggles a tool for one session and reports it back', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);

    const off = await api(app).post(`/api/sessions/${session.id}/tools/lint_luau`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ sessionId: session.id, name: 'lint_luau', enabled: false });

    const tools = await api(app).get(`/api/tools?sessionId=${session.id}`);
    expect(tools.body.find((tool: { name: string }) => tool.name === 'lint_luau').enabled).toBe(false);
    expect(tools.body.find((tool: { name: string }) => tool.name === 'todo_write').enabled).toBe(true);

    const otherSession = await createSession(app, project.id, 'Other');
    const untouched = await api(app).get(`/api/tools?sessionId=${otherSession.id}`);
    expect(untouched.body.find((tool: { name: string }) => tool.name === 'lint_luau').enabled).toBe(true);

    const on = await api(app).post(`/api/sessions/${session.id}/tools/lint_luau`).send({ enabled: true });
    expect(on.body.enabled).toBe(true);

    const unknown = await api(app).post(`/api/sessions/${session.id}/tools/nope`).send({ enabled: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('TOOL_NOT_FOUND');

    const invalid = await api(app).post(`/api/sessions/${session.id}/tools/lint_luau`).send({ enabled: 'no' });
    expect(invalid.status).toBe(400);

    const missingSession = await api(app).post('/api/sessions/sess_missing/tools/lint_luau').send({ enabled: false });
    expect(missingSession.status).toBe(404);
    expect(missingSession.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('mcp routes', () => {
  it('reports the Task 17 status shape exactly', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);

    const res = await api(app).get('/api/mcp/status');
    expect(res.status).toBe(200);
    const status = res.body as McpStatus;
    // Task 31C grew the body: the panel may now name the place, the tool count and the last error.
    expect(Object.keys(status).sort()).toEqual(['connected', 'lastError', 'logs', 'server', 'studio', 'studioLinked', 'toolCount']);
    expect(Object.keys(status.server).sort()).toEqual(['path', 'source', 'version']);
    expect(status).toEqual({
      connected: false,
      studioLinked: false,
      server: { source: 'none', path: null, version: null },
      studio: null,
      toolCount: 0,
      lastError: null,
      logs: [],
    });
  });

  it('re-probes the place when a status read finds a live bridge without one', async () => {
    const { harness, mcp } = buildHarness();
    const app = buildApp(harness);
    mcp.connected = true;
    mcp.studio = null;

    await api(app).get('/api/mcp/status');

    // Boot connects before Studio registers its place; the panel would otherwise say "no place"
    // forever while the place is open.
    expect(mcp.listCalls).toBe(1);
  });

  it('does not re-list when the place is already known', async () => {
    const { harness, mcp } = buildHarness();
    const app = buildApp(harness);
    mcp.connected = true;
    mcp.studio = { id: 'abc', name: 'Place1' };

    await api(app).get('/api/mcp/status');

    expect(mcp.listCalls).toBe(0);
  });

  it('reconnects, re-syncs the tool registry and logs the attempt', async () => {
    const { harness, mcp } = buildHarness();
    const app = buildApp(harness);

    mcp.tools = [{ name: 'run_code', description: 'Run Luau.', parameters: { type: 'object' } }];
    const res = await api(app).post('/api/mcp/reconnect');
    expect(res.status).toBe(200);
    expect(mcp.reconnects).toBe(1);
    expect(res.body.connected).toBe(true);
    expect(res.body.logs.length).toBeGreaterThan(0);
    expect(harness.tools.has('studio.run_code')).toBe(true);
  });

  it('persists a valid path override and rejects an invalid one without touching it', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const dir = makeTempDir();
    const good = path.join(dir, 'rbx-studio-mcp.exe');
    fs.writeFileSync(good, '');
    // A real file whose only claim is living in a Downloads folder: existence cannot be the reason it
    // is refused, so this is the case the old shape-only validator waved through.
    const downloads = path.join(dir, 'Downloads');
    fs.mkdirSync(downloads);
    const foreign = path.join(downloads, 'anything.exe');
    fs.writeFileSync(foreign, '');

    const stored = await api(app).put('/api/mcp/path').send({ path: good });
    expect(stored.status).toBe(200);
    // The route writes a setting; it cannot claim that setting is the running server.
    expect(stored.body.server).toEqual({ source: 'none', path: null, version: null });
    expect(harness.providerSettings.get('mcp')?.baseUrl).toBe(good);

    const bad = await api(app).put('/api/mcp/path').send({ path: 'C:/tmp/weird" ; rm -rf' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: { code: 'MCP_PATH_REJECTED' } });
    expect(harness.providerSettings.get('mcp')?.baseUrl).toBe(good);

    const missing = await api(app).put('/api/mcp/path').send({ path: path.join(dir, 'ghost.exe') });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('MCP_PATH_REJECTED');
    expect(harness.providerSettings.get('mcp')?.baseUrl).toBe(good);

    // Every one of these is absolute, ends in `.exe` and exists on at least one machine, so only the
    // official-name/official-root allowlist can stop them becoming the next boot's spawn target.
    for (const rejected of [
      'C:/Windows/System32/cmd.exe',
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      foreign,
    ]) {
      const res = await api(app).put('/api/mcp/path').send({ path: rejected });
      expect(res.status, rejected).toBe(400);
      expect(res.body).toEqual({ error: { code: 'MCP_PATH_REJECTED' } });
      expect(harness.providerSettings.get('mcp')?.baseUrl, rejected).toBe(good);
    }

    const cleared = await api(app).put('/api/mcp/path').send({ path: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.server).toEqual({ source: 'none', path: null, version: null });
    expect(harness.providerSettings.get('mcp')?.baseUrl).toBeUndefined();

    const wrongType = await api(app).put('/api/mcp/path').send({ path: 42 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('keeps the full path out of the status log lines', () => {
    const dir = makeTempDir();
    const stored = path.join(dir, 'rbx-studio-mcp.exe');
    fs.writeFileSync(stored, '');
    const log = createMcpLog();
    const gateway = createMcpGateway(
      {
        connected: false,
        studioLinked: false,
        // Task 31 made the resolved server triple mandatory on the bridge: a gateway may not report a
        // source it never resolved.
        serverInfo: { source: 'none', path: null, version: null },
        connect: async () => undefined,
        close: async () => undefined,
        listTools: async () => ({ tools: [] }),
        callTool: async (_name: string, args: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
      },
      { pathOverride: () => stored, log },
    );

    expect(gateway.server).toEqual({ source: 'none', path: null, version: null });
    expect(log.lines().join('\n')).not.toContain(dir);
    expect(log.lines().join('\n')).toContain('rbx-studio-mcp.exe');
  });

  it('refuses to advertise a settings source the bridge cannot name', async () => {
    const dir = makeTempDir();
    const stored = path.join(dir, 'rbx-studio-mcp.exe');
    fs.writeFileSync(stored, '');
    const log = createMcpLog();
    const bridge = new LegacyStubBridge();
    const gateway = createMcpGateway(bridge, { log, pathOverride: () => stored });

    expect(gateway.server).toEqual({ source: 'none', path: null, version: null });

    await gateway.reconnect();
    expect(bridge.connected).toBe(true);
    expect(mcpStatusOf(gateway)).toEqual({
      connected: true,
      studioLinked: false,
      server: { source: 'none', path: null, version: null },
      // Nothing was listed and no call ran, so there is no place, no count and no error to report.
      studio: null,
      toolCount: 0,
      lastError: null,
      logs: gateway.logs,
    });

    const lines = log.lines().join('\n');
    // Task 31: an unidentified process is called out, never presented as `MCP connected from ...`.
    expect(lines).toContain('could not be identified');
    expect(lines).not.toContain('MCP connected from');
    expect(lines).not.toContain(dir);
  });

  it('reports the identity a bridge that can name its process supplies', async () => {
    class NamingBridge extends LegacyStubBridge {
      readonly serverInfo = {
        source: 'studio-builtin' as McpSource,
        path: 'C:/Users/me/AppData/Local/Roblox/Plugins/Studio/mcp.exe',
        version: '2.0.1',
      };
    }
    const log = createMcpLog();
    const gateway = createMcpGateway(new NamingBridge(), { log });

    expect(gateway.server).toEqual({
      source: 'studio-builtin',
      path: 'C:/Users/me/AppData/Local/Roblox/Plugins/Studio/mcp.exe',
      version: '2.0.1',
    });

    await gateway.reconnect();
    const lines = log.lines().join('\n');
    expect(lines).toContain('MCP connected from studio-builtin: mcp.exe');
    expect(lines).not.toContain('legacy');
    expect(lines).not.toContain('C:/Users/me');
  });

  it('accepts only an absolute existing server binary or batch file', () => {
    const dir = makeTempDir();
    const exe = path.join(dir, 'rbx-studio-mcp.exe');
    fs.writeFileSync(exe, '');

    expect(isAllowedMcpPath(exe)).toBe(true);
    expect(isAllowedMcpPath('rbx-studio-mcp.exe')).toBe(false);
    expect(isAllowedMcpPath(`${exe}.txt`)).toBe(false);
    expect(isAllowedMcpPath(`${exe};calc`)).toBe(false);
    expect(isAllowedMcpPath('C:/tmp/a.exe\u0000b')).toBe(false);
    expect(isAllowedMcpPath('')).toBe(false);
    // Case folding is a win32 contract -- `RBX-STUDIO-MCP.EXE` names the same file there. It was
    // asserted without `platform`, so on the Linux runner the same path was a *different* name and the
    // allowlist refused it, which is also correct: the assertion, not the code, was platform-specific.
    expect(isAllowedMcpPath(exe.toUpperCase(), { platform: 'win32', exists: () => true })).toBe(true);
    if (process.platform !== 'win32') {
      expect(isAllowedMcpPath(exe.toUpperCase(), { exists: () => true })).toBe(false);
    }
    expect(isAllowedMcpPath(path.join(dir, 'ghost.exe'))).toBe(false);
  });

  it('refuses an existing executable that is not the official Roblox MCP server', () => {
    // `exists: () => true` removes existence from the equation: what rejects these is the allowlist.
    const win32 = {
      platform: 'win32' as const,
      env: { LOCALAPPDATA: 'C:/Users/me/AppData/Local' },
      exists: () => true,
    };

    expect(isAllowedMcpPath('C:/Windows/System32/cmd.exe', win32)).toBe(false);
    expect(isAllowedMcpPath('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', win32)).toBe(false);
    expect(isAllowedMcpPath('C:/Users/me/Downloads/anything.exe', win32)).toBe(false);
    expect(isAllowedMcpPath('C:/Program Files/Somebody Else/mcp/rbx-studio-mcp.bat', win32)).toBe(false);

    // The official basename anywhere, and anything Roblox's own installer dropped in its own folder.
    expect(isAllowedMcpPath('C:/Users/me/Downloads/rbx-studio-mcp.exe', win32)).toBe(true);
    expect(isAllowedMcpPath('C:/Users/me/AppData/Local/Roblox/Plugins/Studio/mcp.bat', win32)).toBe(true);
    expect(isAllowedMcpPath('c:/users/me/appdata/local/ROBLOX/mcp.cmd', win32)).toBe(true);
    // A `..` segment must not walk back out of the Roblox root.
    expect(isAllowedMcpPath('C:/Users/me/AppData/Local/Roblox/../../Windows/cmd.exe', win32)).toBe(false);
    // Without LOCALAPPDATA there is no install root to hide behind.
    expect(isAllowedMcpPath('C:/Users/me/AppData/Local/Roblox/mcp.bat', { platform: 'win32' as const, env: {}, exists: () => true })).toBe(false);

    expect(
      isAllowedMcpPath('/Applications/RobloxStudio.app/Contents/MacOS/studio-mcp.exe', {
        platform: 'darwin' as const,
        exists: () => true,
      }),
    ).toBe(true);
    expect(
      isAllowedMcpPath('/Applications/Other.app/Contents/MacOS/other.exe', {
        platform: 'darwin' as const,
        exists: () => true,
      }),
    ).toBe(false);
  });

  it('accepts a path under the machine real Roblox root', async () => {
    // Only win32 has a LOCALAPPDATA to fake; the darwin branch is covered by the validator unit above.
    if (process.platform !== 'win32') return;
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const dir = makeTempDir();
    const roblox = path.join(dir, 'Roblox', 'Plugins', 'Studio');
    fs.mkdirSync(roblox, { recursive: true });
    const bat = path.join(roblox, 'rbx-mcp.bat');
    fs.writeFileSync(bat, '');

    process.env.LOCALAPPDATA = dir;
    try {
      const stored = await api(app).put('/api/mcp/path').send({ path: bat });
      expect(stored.status).toBe(200);
      expect(harness.providerSettings.get('mcp')?.baseUrl).toBe(bat);

      const outside = path.join(dir, 'NotRoblox', 'rbx-mcp.bat');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, '');
      const rejected = await api(app).put('/api/mcp/path').send({ path: outside });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('MCP_PATH_REJECTED');
      expect(harness.providerSettings.get('mcp')?.baseUrl).toBe(bat);
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
    }
  });
});

describe('memory routes', () => {
  it('reflects the rows the routes created', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);
    harness.events.append(session.id, [
      { type: 'turn/start', payload: { turnId: 'turn_1', modelSelection: 'auto', trigger: 'user' } },
    ]);

    const res = await api(app).get('/api/memory/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: 1,
      sessions: 1,
      events: 2,
      approxBytes: expect.any(Number),
    });
    expect(res.body).not.toHaveProperty('legacyBackup');
  });

  it('names the v1 backup when the legacy database was moved aside', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'morphi.db');
    fs.writeFileSync(`${filePath}.v1.bak`, '');

    const db = createTestDb(filePath);
    const llm = new LlmRegistry([new FakeAdapter('fake', [])], ['fake']);
    const harness = createHarness({
      db,
      llm,
      mcp: new StubGateway(),
      titleModel: 'auto',
      providerSettings: createProviderSettingsStore(db),
      compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
    });
    const app = buildApp(harness);

    const res = await api(app).get('/api/memory/stats');
    expect(res.body.legacyBackup).toBe('morphi.db.v1.bak');
    db.close();
  });

  it('clears conversation data and keeps provider settings', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);
    await api(app).put('/api/providers/fake/config').send({ enabled: false });
    await api(app).post(`/api/sessions/${session.id}/tools/todo_write`).send({ enabled: false });
    // The real session id, before the wipe: asserting an unrelated one would pass even if `clear()`
    // left every per-session switch in place.
    expect(harness.toolPrefs.disabledFor(session.id)).toEqual(['todo_write']);

    const res = await api(app).del('/api/memory');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cleared: { projects: 1, sessions: 1, events: 1 } });
    expect((await api(app).get('/api/memory/stats')).body).toMatchObject({ projects: 0, sessions: 0, events: 0 });
    expect(harness.providerSettings.get('fake')).toMatchObject({ enabled: false });
    expect(harness.toolPrefs.disabledFor(session.id)).toEqual([]);
    expect(harness.toolPrefs.isEnabled(session.id, 'todo_write')).toBe(true);
  });
});

describe('harness composition', () => {
  it('wires the stores, the shared inbox and the mcp mirror', async () => {
    const { harness, mcp } = buildHarness();
    await mcp.connect();
    await harness.syncTools();

    // Not just "a property exists": the composition root must hand the routes stores that read the
    // database it was given, or every route test below would pass against an empty stub.
    const project = harness.projects.create('Composed');
    const session = harness.sessions.create(project.id, 'Composed session');
    expect(harness.projects.get(project.id)?.name).toBe('Composed');
    expect(harness.sessions.list().map((row) => row.id)).toEqual([session.id]);
    expect(harness.sessions.get(session.id)).toMatchObject({ id: session.id, projectName: 'Composed', title: 'Composed session' });
    expect(harness.inbox.push('sess_1', ' nội dung ')).toBe(1);
    expect(harness.inbox.drain('sess_1')).toEqual(['nội dung']);
    expect(harness.tools.get('studio.script_read')).toBeDefined();
    expect(harness.tools.get('studio.script_read')?.presentation.label).toBe('Đọc script');

    mcp.tools = [{ name: 'run_code', description: 'Run Luau.', parameters: { type: 'object' } }];
    await harness.syncTools();
    expect(harness.tools.has('studio.run_code')).toBe(true);
  });

  it('reports a session busy while a turn owns it and releases it afterwards', () => {
    const { harness } = buildHarness();
    expect(harness.busy('sess_1')).toBe(false);

    const controller = harness.cancellations.start('sess_1');
    expect(harness.busy('sess_1')).toBe(true);

    harness.cancellations.finish('sess_1', controller);
    expect(harness.busy('sess_1')).toBe(false);

    // Cancel must release too: a turn that is torn down by `cancel()` would otherwise stay busy.
    const second = harness.cancellations.start('sess_1');
    expect(harness.busy('sess_1')).toBe(true);
    expect(harness.cancellations.cancel('sess_1')).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(harness.busy('sess_1')).toBe(false);
  });

  it('stops reporting a deleted session as busy', async () => {
    const { harness } = buildHarness();
    const app = buildApp(harness);
    const project = await createProject(app);
    const session = await createSession(app, project.id);

    // The delete route aborts the turn it is about to orphan; `busy()` must not stay true for the id.
    harness.cancellations.start(session.id);
    expect(harness.busy(session.id)).toBe(true);

    expect((await api(app).del(`/api/sessions/${session.id}`)).status).toBe(200);
    expect(harness.busy(session.id)).toBe(false);
  });

  it('treats a session holding an exclusive tool slot as busy', async () => {
    const { harness } = buildHarness();
    let releaseGate: (() => void) | undefined;
    harness.tools.register({
      name: 'hang_out_to_longer',
      description: 'Never settles.',
      parameters: { type: 'object' },
      isConcurrencySafe: false,
      approval: 'auto',
      presentation: { label: 'Hang', risk: 'low' },
      execute: () => new Promise<unknown>((resolve) => { releaseGate = () => resolve({ done: true }); }),
    });

    const running = harness.pipeline.run(
      [{ id: 'call_1', name: 'hang_out_to_longer', args: {} }],
      {
        sessionId: 'sess_gate',
        turnId: 'turn_1',
        stepId: 'step_1',
        signal: new AbortController().signal,
        emit: { durable: () => undefined, live: () => undefined },
        mcp: harness.mcp,
      },
    );

    await expect.poll(() => harness.busy('sess_gate')).toBe(true);
    harness.pipeline.releaseSession('sess_gate');
    expect(harness.busy('sess_gate')).toBe(false);
    releaseGate?.();
    await running;
  });

  it('keeps the pipeline result codes in one module and the step limit re-exported', async () => {
    const loopModule = await import('../harness/agent/loop');
    const pipelineModule = await import('../harness/tools/pipeline');
    expect(loopModule.MAX_TOOL_CALLS_PER_STEP).toBe(8);
    expect(pipelineModule.MAX_TOOL_CALLS_PER_STEP).toBe(8);
    // `loop.ts` re-exports the step limit only. The six `*_RESULT` values and `ToolResultCode` live
    // in `pipeline.ts` and Task 18 imports them from there: the plan's original "re-exported from
    // `agent/loop.ts`" wording was corrected by the controller, so do not add those re-exports.
    expect(pipelineModule.CANCELLED_RESULT).toBe('CANCELLED');
    expect(pipelineModule.APPROVAL_DENIED_RESULT).toBe('APPROVAL_DENIED');
    expect(pipelineModule.INVALID_ARGS_RESULT).toBe('INVALID_ARGS');
    expect(pipelineModule.UNKNOWN_TOOL_RESULT).toBe('UNKNOWN_TOOL');
    expect(pipelineModule.TOOL_UNAVAILABLE_RESULT).toBe('TOOL_UNAVAILABLE');
    expect(pipelineModule.TOOL_TIMEOUT_RESULT).toBe('TOOL_TIMEOUT');
    expect(loopModule).not.toHaveProperty('CANCELLED_RESULT');
  });
});
