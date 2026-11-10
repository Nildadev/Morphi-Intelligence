import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../../test/db';
import { EventStore } from '../../events/store';
import { SessionStore } from '../../session/store';
import { planActiveOf, setPlanMode } from '../../plan/mode';
import { createExitPlanModeTool } from './plan';
import { createPresentTool } from './present';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  sessions.create('proj_x', 'title');
  const sessionId = sessions.list()[0]?.id ?? '';
  return { events, sessionId };
}

function context(sessionId: string, turnId = 'turn_1') {
  return {
    sessionId,
    turnId,
    stepId: 'step_1',
    callId: 'call_1',
    signal: new AbortController().signal,
    emit: { durable: () => undefined, live: () => undefined } as never,
    mcp: undefined as never,
  };
}

describe('exit_plan_mode tool', () => {
  it('submits a headed plan and leaves plan mode', async () => {
    const { events, sessionId } = fixture();
    setPlanMode(events, sessionId, true);
    const tool = createExitPlanModeTool({ events });

    const result = await tool.execute({ plan: '## Plan\n1. Explore\n2. Build' }, context(sessionId)) as {
      approved: boolean; plan: string;
    };
    expect(result.approved).toBe(true);
    expect(result.plan).toContain('Explore');
    expect(planActiveOf(events, sessionId)).toBe(false);
  });

  it('refuses a plan without a heading and a call outside plan mode', async () => {
    const { events, sessionId } = fixture();
    const tool = createExitPlanModeTool({ events });

    setPlanMode(events, sessionId, true);
    await expect(tool.execute({ plan: 'plain text' }, context(sessionId))).rejects.toThrow(/heading/);

    setPlanMode(events, sessionId, false);
    await expect(tool.execute({ plan: '## Plan\nbody' }, context(sessionId))).rejects.toThrow(
      /not active/,
    );
  });
});

describe('present tool', () => {
  it('records deliverables as a durable event', async () => {
    const { events, sessionId } = fixture();
    const tool = createPresentTool({ events });

    const result = await tool.execute(
      { files: [{ path: 'ServerScriptService/Main.server.lua', description: 'entry' }] },
      context(sessionId),
    ) as Array<{ presented: string }>;
    expect(result).toEqual([{ presented: 'ServerScriptService/Main.server.lua' }]);

    const presented = events.list(sessionId).filter((event) => event.type === 'deliverables/presented');
    expect(presented).toHaveLength(1);
    expect(presented[0].payload).toMatchObject({
      files: [{ path: 'ServerScriptService/Main.server.lua', description: 'entry' }],
    });
  });

  it('rejects empty and oversized file lists', async () => {
    const { events, sessionId } = fixture();
    const tool = createPresentTool({ events });

    await expect(tool.execute({ files: [] }, context(sessionId))).rejects.toThrow(/non-empty/);
    await expect(
      tool.execute(
        { files: Array.from({ length: 9 }, (_unused, index) => ({ path: `S${index}` })) },
        context(sessionId),
      ),
    ).rejects.toThrow(/at most 8/);
  });
});
