import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from './store';
import type { NewSessionEvent } from './types';

const BATCH: NewSessionEvent[] = [
  { type: 'session/created', payload: { projectId: 'p1', title: 'Alpha', modelSelection: 'primary' } },
  { type: 'user/message', payload: { messageId: 'm1', content: 'hello', source: 'user' } },
  { type: 'turn/start', payload: { turnId: 't1', modelSelection: 'primary', trigger: 'user' } },
];

function seed(db: Database.Database, lastUpdated = 1): void {
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run(
    'p1',
    'Project',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', 'p1', 'Session', 1, lastUpdated);
}

describe('EventStore', () => {
  it('appends events with sequential seq, real ids, schema version 1 and parsed payloads', () => {
    const db = createTestDb();
    try {
      seed(db);
      const appended = new EventStore(db).append('s1', BATCH);

      expect(appended.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(appended.every((event) => event.id > 0)).toBe(true);
      expect(appended.map((event) => event.id)).toEqual(
        [...appended.map((event) => event.id)].sort((a, b) => a - b),
      );
      expect(appended.every((event) => event.schemaVersion === 1)).toBe(true);
      expect(new Set(appended.map((event) => event.createdAt)).size).toBe(1);
      expect(appended.every((event) => event.sessionId === 's1')).toBe(true);
      expect(appended.map((event) => event.type)).toEqual([
        'session/created',
        'user/message',
        'turn/start',
      ]);
      expect(appended.map((event) => event.payload)).toEqual(BATCH.map((event) => event.payload));
    } finally {
      db.close();
    }
  });

  it('lists all events in order and filters by afterSeq', () => {
    const db = createTestDb();
    try {
      seed(db);
      const store = new EventStore(db);
      store.append('s1', BATCH);

      expect(store.list('s1').map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(store.list('s1', 1).map((event) => event.seq)).toEqual([2, 3]);
      expect(store.list('s1', 3)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rolls back the whole batch when a later payload cannot be serialized', () => {
    const db = createTestDb();
    try {
      seed(db, 1);
      const store = new EventStore(db);
      const broken = [
        BATCH[0],
        { type: 'user/message', payload: { messageId: 'm2', content: 10n, source: 'user' } },
      ] as any;

      expect(() => store.append('s1', broken)).toThrow();

      expect(store.list('s1')).toEqual([]);
      const session = db
        .prepare('SELECT last_updated FROM sessions WHERE id = ?')
        .get('s1') as { last_updated: number };
      expect(session.last_updated).toBe(1);
    } finally {
      db.close();
    }
  });

  it('advances sessions.last_updated on a successful append', () => {
    const db = createTestDb();
    try {
      seed(db, 1);
      const store = new EventStore(db);

      const appended = store.append('s1', [BATCH[0]]);

      const session = db
        .prepare('SELECT last_updated FROM sessions WHERE id = ?')
        .get('s1') as { last_updated: number };
      expect(session.last_updated).toBeGreaterThan(1);
      expect(session.last_updated).toBe(appended[0].createdAt);
    } finally {
      db.close();
    }
  });

  it('round-trips nested payloads and optional fields through JSON', () => {
    const db = createTestDb();
    try {
      seed(db);
      const events: NewSessionEvent[] = [
        {
          type: 'tool/call',
          payload: { callId: 'c1', name: 'lookup', args: { city: 'Paris', days: 3 }, startedAt: 1000 },
        },
        {
          type: 'assistant/message',
          payload: {
            messageId: 'm1',
            content: 'Done',
            reasoning: 'checked the forecast',
            finishReason: 'tool_calls',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            callIds: ['c1'],
          },
        },
      ];
      const store = new EventStore(db);
      store.append('s1', events);

      expect(store.list('s1').map((event) => event.payload)).toEqual(events.map((event) => event.payload));
    } finally {
      db.close();
    }
  });
});
