import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test/db';
import { createApp } from '../app';
import { createHarness, type Harness } from '../harness/harness';
import { LlmRegistry } from '../harness/llm/registry';
import type { LlmRequest, ModelInfo, ProviderAdapter, StreamEvent } from '../harness/llm/types';
import { createProviderSettingsStore } from '../harness/llm/settings';
import { createMcpGateway, type McpBridge } from '../harness/mcp/serviceGateway';
import { mountRoutes } from './index';

const TOKEN = 'test-token';

class StubBridge implements McpBridge {
  connected = false;
  studioLinked = false;
  serverInfo = { source: 'none' as const, path: null, version: null };
  async connect(): Promise<void> { /* inert */ }
  async close(): Promise<void> { /* inert */ }
  async listTools(): Promise<{ tools?: unknown }> { return { tools: [] }; }
  async callTool(): Promise<unknown> { return { content: [] }; }
}

const MODEL: ModelInfo = {
  id: 'fake-1',
  name: 'Fake',
  provider: 'fake',
  providerLabel: 'Fake',
  context: 32_000,
  // A tool-capable chat model: `resolveAuto` only picks models that declare tool use.
  supportsTools: true,
};

/** Minimal scripted provider: one text answer, no tools, immediate stop. */
class ScriptedAdapter implements ProviderAdapter {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly requests: LlmRequest[] = [];

  async listModels(): Promise<ModelInfo[]> {
    return [MODEL];
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request);
    yield { type: 'text_delta', text: 'child answer' };
    yield { type: 'finish', reason: 'stop' };
  }
}

async function buildApp(): Promise<{ app: Express; harness: Harness; adapter: ScriptedAdapter }> {
  const db = createTestDb();
  const adapter = new ScriptedAdapter();
  const registry = new LlmRegistry([adapter], ['fake']);
  registry.setCredentials({ fake: 'x' });
  await registry.refreshModels();
  const harness = createHarness({
    db,
    llm: registry,
    mcp: createMcpGateway(new StubBridge()),
    titleModel: 'auto',
    providerSettings: createProviderSettingsStore(db),
    compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
  });
  const app = createApp({ token: TOKEN, version: '1.1.0', mount: (target) => mountRoutes(target, harness) });
  return { app, harness, adapter };
}

const authed = (app: Express) => ({
  get: (url: string) => request(app).get(url).set('X-Morphi-Token', TOKEN),
  post: (url: string, body?: unknown) => request(app).post(url).set('X-Morphi-Token', TOKEN)// supertest's `send` only accepts a serialisable body; the helper is deliberately untyped so a
    // test can post a malformed one on purpose (that is what several routes are checked against).
    .send(body as object),
});

async function sessionId(app: Express): Promise<string> {
  const project = await authed(app).post('/api/projects', { name: 'Subagent fixture' });
  expect(project.status).toBe(201);
  const session = await authed(app).post('/api/sessions', { projectId: project.body.id });
  expect(session.status).toBe(201);
  return session.body.id as string;
}

describe('POST /api/sessions/:id/subagent', () => {
  it('starts a child and returns immediately with the running card, then settles with subagent/end', async () => {
    const { app, harness } = await buildApp();
    const id = await sessionId(app);

    const res = await authed(app).post(`/api/sessions/${id}/subagent`, { task: 'Summarise the auth flow.' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id, status: 'running' });
    expect(typeof res.body.subagentId).toBe('string');
    expect(typeof res.body.childSessionId).toBe('string');

    // Poll for settlement (the activation settles asynchronously).
    let parentEvents: ReturnType<typeof harness.events.list> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      parentEvents = harness.events.list(id);
      if (parentEvents.some((event) => event.type === 'subagent/end')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const startEvent = parentEvents.find((event) => event.type === 'subagent/start');
    const endEvent = parentEvents.find((event) => event.type === 'subagent/end');
    expect(startEvent?.payload).toMatchObject({ subagentId: res.body.subagentId, task: 'Summarise the auth flow.' });
    expect(endEvent?.payload).toMatchObject({ status: 'done', summary: 'child answer', toolCount: 0 });
    expect(harness.events.list(res.body.childSessionId).map((event) => event.type)).toContain('turn/end');
  });

  it('lists the tree and interrupts a descendant', async () => {
    const { app, harness } = await buildApp();
    const id = await sessionId(app);
    const res = await authed(app).post(`/api/sessions/${id}/subagent`, { task: 'slow task' });
    expect(res.status).toBe(202);
    const childId = res.body.childSessionId as string;

    const list = await authed(app).get(`/api/sessions/${id}/subagent/list`);
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual(expect.objectContaining({ childSessionId: childId, task: 'slow task' }));

    const denied = await authed(app).post(`/api/sessions/${id}/subagent/${'sess_other'}/interrupt`);
    expect(denied.status).toBe(404);
    // Not running anymore (finished instantly) → accepted no-op.
    const interrupt = await authed(app).post(`/api/sessions/${id}/subagent/${childId}/interrupt`);
    expect(interrupt.status).toBe(200);
    expect(interrupt.body).toMatchObject({ id, childId, accepted: true });
    void harness;
  });

  it('refuses a missing session and an empty task', async () => {
    const { app } = await buildApp();
    const id = await sessionId(app);

    expect((await authed(app).post('/api/sessions/missing/subagent', { task: 'x' })).status).toBe(404);
    expect((await authed(app).post(`/api/sessions/${id}/subagent`, { task: '  ' })).status).toBe(400);
    expect((await authed(app).post(`/api/sessions/${id}/subagent`, {})).status).toBe(400);
  });

  it('caps nesting depth at 2', async () => {
    const { app } = await buildApp();
    const id = await sessionId(app);

    const level1 = await authed(app).post(`/api/sessions/${id}/subagent`, { task: 'level one' });
    expect(level1.status).toBe(202);
    const level2 = await authed(app).post(`/api/sessions/${level1.body.childSessionId}/subagent`, { task: 'level two' });
    expect(level2.status).toBe(202);
    const level3 = await authed(app).post(`/api/sessions/${level2.body.childSessionId}/subagent`, { task: 'level three' });
    expect(level3.status).toBe(422);
  });
});
