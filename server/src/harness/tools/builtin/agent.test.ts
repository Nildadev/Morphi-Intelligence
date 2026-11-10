import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../../test/db';
import { EventStore } from '../../events/store';
import { SessionStore } from '../../session/store';
import { SkillLoader } from '../../skills/loader';
import { createGoalTools, createSkillTool } from './agent';

function context(sessionId: string): Parameters<ReturnType<typeof createSkillTool>['execute']>[1] {
  return {
    sessionId,
    turnId: 'turn_1',
    stepId: 'step_1',
    callId: 'call_1',
    signal: new AbortController().signal,
    emit: { durable: () => undefined, live: () => undefined } as never,
    mcp: undefined as never,
  };
}

describe('skill tool', () => {
  function fixture() {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
    const events = new EventStore(db);
    const loader = new SkillLoader(events);
    const sessions = new SessionStore(db, events);
    sessions.create('proj_x', 'title');
    return { loader, skill: createSkillTool({ loader }), sessionId: sessions.list()[0]?.id ?? '' };
  }

  it('lists the catalog without a name and loads a body by name', async () => {
    const { skill, sessionId } = fixture();

    const listed = await skill.execute({}, context(sessionId)) as { skills: Array<{ name: string }> };
    expect(listed.skills.map((entry) => entry.name)).toContain('morphi-workflow');

    const loaded = await skill.execute({ name: 'morphi-workflow' }, context(sessionId)) as { name: string; content: string };
    expect(loaded.name).toBe('morphi-workflow');
    expect(loaded.content).toContain('Skill: the working loop');
  });

  it('activates the skill for the session so later turns inject it', async () => {
    const { loader, skill, sessionId } = fixture();

    await skill.execute({ name: 'morphi-tdd' }, context(sessionId));
    expect(loader.active(sessionId)).toEqual(['morphi-tdd']);
  });

  it('refuses an unknown skill name', async () => {
    const { skill, sessionId } = fixture();

    await expect(skill.execute({ name: 'nope' }, context(sessionId))).rejects.toThrow(/unknown/);
  });
});

describe('goal tools', () => {
  function fixture() {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
    const events = new EventStore(db);
    const sessions = new SessionStore(db, events);
    sessions.create('proj_x', 'title');
    const sessionId = sessions.list()[0]?.id ?? '';
    return { events, sessions, sessionId };
  }

  it('creates, reads and ends a goal through the same durable events', async () => {
    const { events, sessions, sessionId } = fixture();
    const [getGoal, setGoal] = createGoalTools({ events, sessions });

    expect(await getGoal.execute({}, context(sessionId))).toEqual({ goal: null });

    const created = await setGoal.execute({ objective: 'Ship the tutorial level' }, context(sessionId)) as {
      id: string; goalId: string; status: string; objective: string;
    };
    expect(created).toMatchObject({ status: 'active', objective: 'Ship the tutorial level' });

    const read = await getGoal.execute({}, context(sessionId)) as { goal: { id: string; objective: string; status: string } };
    expect(read.goal.objective).toBe('Ship the tutorial level');
    expect(read.goal.status).toBe('active');

    const ended = await setGoal.execute({ status: 'done' }, context(sessionId)) as { status: string };
    expect(ended.status).toBe('done');
    const reread = await getGoal.execute({}, context(sessionId)) as { goal: { status: string } };
    expect(reread.goal.status).toBe('done');
  });

  it('requires an objective to start and an existing goal to end', async () => {
    const { events, sessions, sessionId } = fixture();
    const [getGoal, setGoal] = createGoalTools({ events, sessions });

    await expect(setGoal.execute({}, context(sessionId))).rejects.toThrow(/objective/);
    await expect(setGoal.execute({ status: 'done' }, context(sessionId))).rejects.toThrow(/no current goal/);
    expect(await getGoal.execute({}, context(sessionId))).toEqual({ goal: null });
  });
});
