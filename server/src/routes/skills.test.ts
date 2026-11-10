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
  post: (url: string, body: unknown) => request(app).post(url).set('X-Morphi-Token', TOKEN).send(body),
});

async function sessionId(app: Express): Promise<string> {
  const project = await authed(app).post('/api/projects', { name: 'Skills fixture' });
  expect(project.status).toBe(201);
  const session = await authed(app).post('/api/sessions', { projectId: project.body.id });
  expect(session.status).toBe(201);
  return session.body.id as string;
}

describe('GET /api/skills', () => {
  it('lists the built-in working-agreement skills without leaking their bodies', async () => {
    const { app } = buildApp();
    const res = await authed(app).get('/api/skills');

    expect(res.status).toBe(200);
    const names = res.body.map((skill: { name: string }) => skill.name);
    expect(names).toContain('morphi-brainstorm');
    expect(names).toContain('morphi-tdd');
    expect(names).toContain('morphi-verify');
    expect(names).toContain('morphi-workflow');
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(res.body)).not.toContain('## Skill:');
  });

  it('refuses an unauthenticated read', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/skills');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/sessions/:id/skills/:name', () => {
  it('persists the active skill list and reports the state', async () => {
    const { app, harness } = buildApp();
    const id = await sessionId(app);

    const on = await authed(app).post(`/api/sessions/${id}/skills/morphi-tdd`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ sessionId: id, name: 'morphi-tdd', enabled: true });
    expect(harness.skills.active(id)).toEqual(['morphi-tdd']);

    const off = await authed(app).post(`/api/sessions/${id}/skills/morphi-tdd`, { enabled: false });
    expect(off.body).toEqual({ sessionId: id, name: 'morphi-tdd', enabled: false });
    expect(harness.skills.active(id)).toEqual([]);
  });

  it('refuses an unknown skill name and a missing session', async () => {
    const { app } = buildApp();
    const id = await sessionId(app);

    expect((await authed(app).post(`/api/sessions/${id}/skills/nope`, { enabled: true })).status).toBe(404);
    expect((await authed(app).post('/api/sessions/missing/skills/morphi-tdd', { enabled: true })).status).toBe(404);
  });
});
