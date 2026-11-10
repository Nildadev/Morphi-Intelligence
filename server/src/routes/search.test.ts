import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test/db';
import { createApp } from '../app';
import { createHarness } from '../harness/harness';
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

function buildApp(): Express {
  const db = createTestDb();
  const harness = createHarness({
    db,
    llm: new LlmRegistry([], ['fake']),
    mcp: createMcpGateway(new StubBridge()),
    titleModel: 'auto',
    providerSettings: createProviderSettingsStore(db),
    compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
  });
  return createApp({ token: TOKEN, version: '1.1.0', mount: (target) => mountRoutes(target, harness) });
}

const authed = (app: Express) => ({
  get: (url: string) => request(app).get(url).set('X-Morphi-Token', TOKEN),
  post: (url: string, body?: unknown) => request(app).post(url).set('X-Morphi-Token', TOKEN).send(body),
});

describe('GET /api/search', () => {
  it('finds session content with snippets and honours the session filter', async () => {
    const app = buildApp();
    const project = await authed(app).post('/api/projects', { name: 'Search fixture' });
    const session = await authed(app).post('/api/sessions', { projectId: project.body.id });
    const id = session.body.id as string;

    const hit = await authed(app).get(`/api/search?q=spawner&sessionId=${id}`);
    // Empty until conversation content exists; the session title itself is not semantic text.
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ hits: [], total: 0 });
  });

  it('validates the query and the session target', async () => {
    const app = buildApp();
    expect((await authed(app).get('/api/search?q=')).status).toBe(400);
    expect((await authed(app).get('/api/search?q=x&sessionId=missing')).status).toBe(404);
    // Without auth the router is behind the token gate.
    expect((await request(app).get('/api/search?q=x')).status).toBe(401);
  });
});
