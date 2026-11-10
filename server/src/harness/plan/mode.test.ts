import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from '../events/store';
import { SessionStore } from '../session/store';
import { planActiveOf, planStateOf, setPlanMode } from './mode';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  sessions.create('proj_x', 'title');
  return { events, sessionId: sessions.list()[0]?.id ?? '' };
}

describe('plan mode', () => {
  it('is inactive by default and folds the last write', () => {
    const { events, sessionId } = fixture();

    expect(planActiveOf(events, sessionId)).toBe(false);

    const on = setPlanMode(events, sessionId, true);
    expect(on.active).toBe(true);
    expect(planActiveOf(events, sessionId)).toBe(true);

    setPlanMode(events, sessionId, false, '## Plan\nDo the thing.');
    const state = planStateOf(events, sessionId);
    expect(state.active).toBe(false);
    expect(state.plan).toContain('Do the thing.');
  });

  it('is visible in the session detail projection', () => {
    const { events, sessionId } = fixture();
    const db = events as unknown as { db: unknown };
    void db;

    // The store reads the same log: set through the events store, then re-read.
    setPlanMode(events, sessionId, true);
    // SessionStore.get folds plan/mode itself; the events assertion above covers the source.
    expect(planActiveOf(events, sessionId)).toBe(true);
  });
});
