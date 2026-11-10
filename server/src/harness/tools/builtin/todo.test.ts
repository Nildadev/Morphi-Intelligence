import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../../test/db';
import { EventStore } from '../../events/store';
import { SessionStore } from '../../session/store';
import { createTodoTool, latestTodos } from './todo';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  sessions.create('proj_x', 'title');
  return { events, sessionId: sessions.list()[0]?.id ?? '' };
}

function context(sessionId: string) {
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

describe('todo_write durable', () => {
  it('persists the list as a todo/write event and folds last-write-wins', async () => {
    const { events, sessionId } = fixture();
    const tool = createTodoTool({ events });

    expect(latestTodos(events, sessionId)).toEqual([]);

    await tool.execute({ todos: [{ title: 'Explore Studio', status: 'doing' }] }, context(sessionId));
    expect(latestTodos(events, sessionId)).toEqual([{ title: 'Explore Studio', status: 'doing' }]);

    await tool.execute({
      todos: [
        { title: 'Explore Studio', status: 'done' },
        { title: 'Write spawner', status: 'todo' },
      ],
    }, context(sessionId));
    expect(latestTodos(events, sessionId)).toEqual([
      { title: 'Explore Studio', status: 'done' },
      { title: 'Write spawner', status: 'todo' },
    ]);
    expect(events.list(sessionId).filter((event) => event.type === 'todo/write')).toHaveLength(2);
  });

  it('accepts a missing list as an empty plan', async () => {
    const { events, sessionId } = fixture();
    const tool = createTodoTool({ events });
    const result = await tool.execute({}, context(sessionId)) as { todos: unknown[] };
    expect(result.todos).toEqual([]);
    expect(latestTodos(events, sessionId)).toEqual([]);
  });
});
