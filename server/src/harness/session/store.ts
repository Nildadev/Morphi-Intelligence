import type Database from 'better-sqlite3';
import { EventStore } from '../events/store';
import type { EventPayloadMap, NewSessionEvent, SessionEvent } from '../events/types';
import { createId } from '../shared/id';
import { deriveMessages, deriveSteps, effectiveEvents } from './projections';
import type { DerivedMessage, DerivedStep } from './projections';

export interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  lastActive: number;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  createdAt: number;
  lastUpdated: number;
  isPinned: boolean;
  status: string;
  modelSelection?: string;
  goalId?: string;
  /** True when this session is a subagent child of a parent session (hidden from the main list). */
  isSubagent?: boolean;
  parentSessionId?: string;
}

export interface SessionDetail extends SessionSummary {
  messages: DerivedMessage[];
  steps: DerivedStep[];
  skills: string[];
  /** Objective of the session's active goal, read off its `goal/changed` events. */
  goal?: string;
  /** Whether plan mode is active, read off its `plan/mode` events. */
  planActive?: boolean;
  /** The durable todo list (last `todo/write` wins), for the composer panel. */
  todos?: Array<{ title: string; status: 'todo' | 'doing' | 'done' }>;
  /** The latest turn's durable provider failure, so reopening a session keeps its error card. */
  error?: { code: string; message: string; retryable: boolean };
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  last_active: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  project_name: string | null;
  title: string | null;
  created_at: number;
  last_updated: number;
  is_pinned: number;
  status: string;
  model_selection: string | null;
  goal_id: string | null;
  is_subagent: number | null;
  parent_session_id: string | null;
}

const SESSION_SELECT = `
  SELECT s.id, s.project_id, p.name AS project_name, s.title, s.created_at, s.last_updated,
         s.is_pinned, s.status, s.model_selection, s.goal_id, s.is_subagent, s.parent_session_id
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
`;

const SESSION_ORDER = 'ORDER BY s.is_pinned DESC, s.last_updated DESC, s.rowid DESC';

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    lastActive: row.last_active,
  };
}

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    title: row.title ?? '',
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    isPinned: row.is_pinned === 1,
    status: row.status,
    modelSelection: row.model_selection ?? undefined,
    goalId: row.goal_id ?? undefined,
    isSubagent: row.is_subagent === 1 ? true : undefined,
    parentSessionId: row.parent_session_id ?? undefined,
  };
}

export class ProjectStore {
  constructor(private db: Database.Database) {}

  create(name: string, description?: string): ProjectRecord {
    const now = Date.now();
    const id = createId('proj');
    this.db
      .prepare('INSERT INTO projects (id, name, description, created_at, last_active) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, description ?? null, now, now);
    return { id, name, description, createdAt: now, lastActive: now };
  }

  list(): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT id, name, description, created_at, last_active FROM projects ORDER BY last_active DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  /** One indexed row: routes use this instead of `list().some()` for an existence check. */
  get(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT id, name, description, created_at, last_active FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}

export class SessionStore {
  constructor(private db: Database.Database, private events: EventStore) {}

  create(projectId: string, title: string, modelSelection?: string, opts?: { parentSessionId?: string; isSubagent?: boolean }): SessionSummary {
    const now = Date.now();
    const id = createId('sess');
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated, model_selection, is_subagent, parent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, title, now, now, modelSelection ?? null, opts?.isSubagent ? 1 : 0, opts?.parentSessionId ?? null);
      this.events.append(id, [{ type: 'session/created', payload: { projectId, title, modelSelection } }]);
    })();
    return {
      id,
      projectId,
      title,
      createdAt: now,
      lastUpdated: now,
      isPinned: false,
      status: 'idle',
      modelSelection,
      isSubagent: opts?.isSubagent ? true : undefined,
      parentSessionId: opts?.parentSessionId,
    };
  }

  /**
   * Main-list sessions only: subagent children are members of their parent's team (deepseek),
   * not rows in the sidebar/recents list. Callers that need a child fetch it by id via `get()`.
   */
  list(projectId?: string): SessionSummary[] {
    const rows = (projectId
      ? this.db.prepare(`${SESSION_SELECT} WHERE s.project_id = ? AND COALESCE(s.is_subagent, 0) = 0 ${SESSION_ORDER}`).all(projectId)
      : this.db.prepare(`${SESSION_SELECT} WHERE COALESCE(s.is_subagent, 0) = 0 ${SESSION_ORDER}`).all()) as SessionRow[];
    return rows.map(toSummary);
  }

  /**
   * Sidebar-visible sessions: only rows that already carry a user or assistant message. A freshly
   * created "new chat" row (no messages yet) must not clutter the list before the first send.
   */
  listVisible(projectId?: string): SessionSummary[] {
    const hasMessage = `EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = s.id AND e.type IN ('user/message', 'assistant/message'))`;
    const rows = (projectId
      ? this.db.prepare(`${SESSION_SELECT} WHERE s.project_id = ? AND COALESCE(s.is_subagent, 0) = 0 AND ${hasMessage} ${SESSION_ORDER}`).all(projectId)
      : this.db.prepare(`${SESSION_SELECT} WHERE COALESCE(s.is_subagent, 0) = 0 AND ${hasMessage} ${SESSION_ORDER}`).all()) as SessionRow[];
    return rows.map(toSummary);
  }

  get(id: string): SessionDetail | undefined {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    if (!row) return undefined;
    const events = effectiveEvents(this.events.list(id));
    let skills: string[] = [];
    let goal: string | undefined;
    let planActive: boolean | undefined;
    let todos: Array<{ title: string; status: 'todo' | 'doing' | 'done' }> | undefined;
    let error: { code: string; message: string; retryable: boolean } | undefined;
    for (const event of events) {
      if (event.type === 'session/skills') {
        skills = (event.payload as EventPayloadMap['session/skills']).skills;
      }
      if (event.type === 'goal/changed') {
        // Latest write wins (the loop reads the log the same way for its prompt context).
        goal = (event.payload as EventPayloadMap['goal/changed']).status === 'active'
          ? (event.payload as EventPayloadMap['goal/changed']).objective
          : undefined;
      }
      if (event.type === 'plan/mode') {
        planActive = (event.payload as EventPayloadMap['plan/mode']).active;
      }
      if (event.type === 'todo/write') {
        todos = (event.payload as EventPayloadMap['todo/write']).todos;
      }
      if (event.type === 'turn/start') {
        // A new turn is the boundary that clears the previous failure.
        error = undefined;
      }
      if (event.type === 'turn/end') {
        error = (event.payload as EventPayloadMap['turn/end']).error;
      }
    }
    return {
      ...toSummary(row),
      messages: deriveMessages(events),
      steps: deriveSteps(events),
      skills,
      ...(goal === undefined ? {} : { goal }),
      ...(planActive === undefined ? {} : { planActive }),
      ...(todos === undefined ? {} : { todos }),
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Existence only. `get()` replays and derives the whole event log, which routes never need just
   * to answer 404, and the events-replay route would then read that log twice per poll.
   */
  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1').get(id) !== undefined;
  }

  rename(id: string, title: string, source: 'auto' | 'user' = 'user'): SessionEvent {
    let row: SessionEvent;
    this.db.transaction(() => {
      [row] = this.events.append(id, [{ type: 'session/title', payload: { title, source } }]);
      this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
    })();
    // The row is assigned inside the transaction, which has already settled by here; the local
    // definite-assignment dance only satisfies the compiler.
    return row!;
  }

  updateModelSelection(id: string, selection: string): void {
    this.db.prepare('UPDATE sessions SET model_selection = ? WHERE id = ?').run(selection, id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  /**
   * The pointer is only a cache: `goal/changed` events are the source of truth, and `goalId` on
   * the row lets list views warn about a goal without replaying the log.
   */
  setGoalCache(id: string, goalId: string | null): void {
    this.db.prepare('UPDATE sessions SET goal_id = ? WHERE id = ?').run(goalId, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
