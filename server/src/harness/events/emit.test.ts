import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from './store';
import { createEmit } from './emit';
import type { LiveEvent } from '../shared/types';
import type { NewSessionEvent, SessionEvent } from './types';

const USER_MESSAGE: NewSessionEvent = {
  type: 'user/message',
  payload: { messageId: 'm1', content: 'hello', source: 'user' },
};

const STATUS: LiveEvent = { type: 'agent/status', payload: { state: 'thinking', turnId: 't1' } };

let db: Database.Database | undefined;

function open(): EventStore {
  db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'Project', 1, 1);
  db.prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)').run('s1', 'p1', 'Session', 1, 1);
  return new EventStore(db);
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('createEmit', () => {
  it('appends durable events to the store with store-assigned identity', () => {
    const store = open();
    const emitted: SessionEvent[] = [];
    const emit = createEmit(store, 's1', (event) => emitted.push(event as SessionEvent));

    emit.durable(USER_MESSAGE);

    const rows = store.list('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(1);
    expect(rows[0].sessionId).toBe('s1');
    expect(rows[0].type).toBe('user/message');
    expect(rows[0].payload).toEqual(USER_MESSAGE.payload);
    expect(rows[0].schemaVersion).toBe(1);
    expect(rows[0].id).toBeGreaterThan(0);
    expect(emitted).toEqual(rows);
  });

  it('assigns increasing seq per durable call and forwards every persisted event', () => {
    const store = open();
    const emitted: SessionEvent[] = [];
    const emit = createEmit(store, 's1', (event) => emitted.push(event as SessionEvent));

    emit.durable(USER_MESSAGE);
    emit.durable({ type: 'turn/start', payload: { turnId: 't1', modelSelection: 'auto', trigger: 'user' } });

    expect(emitted.map((event) => event.seq)).toEqual([1, 2]);
    expect(emitted.map((event) => event.type)).toEqual(['user/message', 'turn/start']);
    expect(store.list('s1').map((event) => event.seq)).toEqual([1, 2]);
  });

  it('forwards live events to the sink without appending anything', () => {
    const store = open();
    const received: unknown[] = [];
    const emit = createEmit(store, 's1', (event) => received.push(event));

    emit.live(STATUS);

    expect(store.list('s1')).toEqual([]);
    expect(received).toEqual([STATUS]);
  });

  it('works without a sink and keeps durable appending functional', () => {
    const store = open();
    const emit = createEmit(store, 's1');

    expect(() => emit.durable(USER_MESSAGE)).not.toThrow();
    expect(() => emit.live(STATUS)).not.toThrow();
    expect(store.list('s1')).toHaveLength(1);
  });

  it('routes each durable event to the session the emit was created for', () => {
    const store = open();
    db!.prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)').run('s2', 'p1', 'Other', 1, 1);
    const other = createEmit(store, 's2');

    other.durable(USER_MESSAGE);

    expect(store.list('s1')).toEqual([]);
    expect(store.list('s2').map((event) => event.seq)).toEqual([1]);
  });
});
