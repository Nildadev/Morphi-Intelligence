import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { createHarness, type Harness } from '../harness';
import { LlmRegistry } from '../llm/registry';
import { createProviderSettingsStore } from '../llm/settings';
import { createMcpGateway, type McpBridge } from '../mcp/serviceGateway';
import { assembleSystemPrompt } from './assemble';

class StubBridge implements McpBridge {
  connected = false;
  studioLinked = false;
  serverInfo = { source: 'none' as const, path: null, version: null };
  async connect(): Promise<void> { /* inert */ }
  async close(): Promise<void> { /* inert */ }
  async listTools(): Promise<{ tools?: unknown }> { return { tools: [] }; }
  async callTool(): Promise<unknown> { return { content: [] }; }
}

function seedSession(db: Database.Database, sessionId = 's1'): void {
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run('p1', 'Fixture project', 1, 1);
  db.prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, 'p1', 'Fixture session', 1, 1);
}

function harness(): Harness {
  const db: Database.Database = createTestDb();
  seedSession(db);
  return createHarness({
    db,
    llm: new LlmRegistry([], ['fake']),
    mcp: createMcpGateway(new StubBridge()),
    titleModel: 'auto',
    providerSettings: createProviderSettingsStore(db),
    compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
  });
}

const context = (message: string) => ({
  sessionId: 's1',
  turnId: 't1',
  model: { id: 'fake-tools', name: 'fake', provider: 'fake', providerLabel: 'Fake', supportsTools: true },
  window: 8192,
  message,
});

/**
 * Regression guard for the in-app agent: the superpowers-derived rules must reach the REAL system
 * prompt, and a matching trigger must inject the matching skill body for that one turn only.
 */
describe('in-app agent working agreement wiring', () => {
  it('always ships the working agreement even with no active skill', () => {
    const bodies = harness().promptHook?.(context('hello'))?.skills ?? [];
    const prompt = assembleSystemPrompt({ tools: [], skills: bodies });

    expect(prompt).toContain('## Working agreement');
    expect(prompt).toContain('mandatory workflows, not suggestions');
    expect(prompt).toContain('Evidence over claims');
    expect(prompt).not.toContain('## Active skills');
  });

  it('injects the TDD skill body when the user message contains its trigger', () => {
    const bodies = harness().promptHook?.(context('viết test trước khi sửa script này'))?.skills ?? [];
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('RED-GREEN-REFACTOR');

    const prompt = assembleSystemPrompt({ tools: [], skills: bodies });
    expect(prompt).toContain('## Active skills');
    expect(prompt).toContain('Write the failing assertion first');
  });

  it('unions persisted and triggered skills, once each, in catalogue order', () => {
    const agent = harness();
    agent.skills.setActive('s1', ['morphi-tdd']);
    const bodies = agent.promptHook?.(context('/plan và /verify cùng lúc'))?.skills ?? [];

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('bite-sized plan');
    expect(bodies[1]).toContain('RED-GREEN-REFACTOR');
    expect(bodies[2]).toContain('evidence before completion');
  });
});
