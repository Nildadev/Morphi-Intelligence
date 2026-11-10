import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test/db';
import { createApp } from '../app';
import { createHarness, type Harness } from '../harness/harness';
import { LlmRegistry } from '../harness/llm/registry';
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

function buildApp(): { app: Express; harness: Harness } {
  const db = createTestDb();
  const harness = createHarness({
    db,
    llm: new LlmRegistry([], ['fake']),
    mcp: createMcpGateway(new StubBridge()),
    titleModel: 'auto',
    providerSettings: createProviderSettingsStore(db),
    compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
  });
  const app = createApp({ token: TOKEN, version: '1.1.0', mount: (target) => mountRoutes(target, harness) });
  return { app, harness };
}

const authed = (app: Express) => ({
  get: (url: string) => request(app).get(url).set('X-Morphi-Token', TOKEN),
  post: (url: string, body?: unknown) => request(app).post(url).set('X-Morphi-Token', TOKEN).send(body),
  delete: (url: string) => request(app).delete(url).set('X-Morphi-Token', TOKEN),
});

async function sessionId(app: Express): Promise<string> {
  const project = await authed(app).post('/api/projects', { name: 'Plan fixture' });
  expect(project.status).toBe(201);
  const session = await authed(app).post('/api/sessions', { projectId: project.body.id });
  expect(session.status).toBe(201);
  return session.body.id as string;
}

describe('POST /api/sessions/:id/plan', () => {
  it('toggles plan mode durably and surfaces it on the session detail', async () => {
    const { app } = buildApp();
    const id = await sessionId(app);

    const on = await authed(app).post(`/api/sessions/${id}/plan`, { active: true });
    expect(on.status).toBe(201);
    expect(on.body).toMatchObject({ id, active: true });

    const detail = await authed(app).get(`/api/sessions/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.planActive).toBe(true);

    const off = await authed(app).post(`/api/sessions/${id}/plan`, { active: false });
    expect(off.status).toBe(201);
    const cleared = await authed(app).get(`/api/sessions/${id}`);
    expect(cleared.body.planActive).toBe(false);
  });

  it('refuses a missing session and a malformed body', async () => {
    const { app } = buildApp();
    const id = await sessionId(app);

    expect((await authed(app).post('/api/sessions/missing/plan', { active: true })).status).toBe(404);
    expect((await authed(app).post(`/api/sessions/${id}/plan`, {})).status).toBe(400);
  });
});

describe('DELETE /api/sessions/:id/plan', () => {
  it('leaves plan mode so the session detail answers inactive', async () => {
    const { app } = buildApp();
    const id = await sessionId(app);
    await authed(app).post(`/api/sessions/${id}/plan`, { active: true });

    const res = await authed(app).delete(`/api/sessions/${id}/plan`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id });

    const detail = await authed(app).get(`/api/sessions/${id}`);
    expect(detail.body.planActive).toBe(false);
    expect((await authed(app).delete('/api/sessions/missing/plan')).status).toBe(404);
  });
});
