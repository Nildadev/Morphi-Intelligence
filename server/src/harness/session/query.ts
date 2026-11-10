import type Database from 'better-sqlite3';
import type { EventStore } from '../events/store';
import type { SessionStore } from '../session/store';

/**
 * Unified session-history query, adapted from deepseek-harness `dsh-session-query`
 * + `dsh-session-query-sqlite`: exact reads plus ranked full-text search over a
 * derived FTS5 index in the same database (never the source-of-truth table).
 * Search falls back to a LIKE scan when FTS5 is unavailable (test doubles).
 */

export interface SearchHit {
  sessionId: string;
  seq: number;
  type: string;
  snippet: string;
  sessionTitle: string;
}

export interface SearchPage {
  hits: SearchHit[];
  total: number;
}

function semanticText(type: string, payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return String(payload ?? '');
  const p = payload as Record<string, unknown>;
  switch (type) {
    case 'user/message': return typeof p.content === 'string' ? p.content : '';
    case 'assistant/message': return typeof p.content === 'string' ? p.content : '';
    case 'tool/call': return `${String(p.name ?? '')} ${JSON.stringify(p.args ?? '')}`;
    case 'tool/result': {
      const result = p.result;
      return typeof result === 'string' ? result : JSON.stringify(result ?? '');
    }
    case 'goal/changed': return typeof p.objective === 'string' ? p.objective : '';
    case 'plan/mode': return typeof p.plan === 'string' ? p.plan : '';
    case 'compaction/summary': return typeof p.summary === 'string' ? p.summary : '';
    default: return '';
  }
}

export class SessionQuery {
  private db: Database.Database;
  private useFts: boolean;

  constructor(
    private events: EventStore,
    private sessions: SessionStore,
    db: Database.Database,
  ) {
    this.db = db;
    this.useFts = this.ensureIndex();
  }

  private ensureIndex(): boolean {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(session_id, seq UNINDEXED, type, text, tokenize='unicode61');
      `);
      return true;
    } catch {
      // better-sqlite3 builds without FTS5 (some CI images): LIKE fallback still searches.
      return false;
    }
  }

  /** Rebuild the derived index from the source log (one serialized observation). */
  private reconcile(): void {
    const rows = this.db.prepare('SELECT session_id, seq, type, payload FROM session_events ORDER BY session_id, seq').all() as Array<{
      session_id: string; seq: number; type: string; payload: string;
    }>;
    const titles = new Map<string, string>();
    for (const session of this.sessions.list()) titles.set(session.id, session.title);

    if (this.useFts) {
      const transaction = this.db.transaction(() => {
        this.db.exec('DELETE FROM session_search_fts;');
        const insert = this.db.prepare('INSERT INTO session_search_fts (session_id, seq, type, text) VALUES (?, ?, ?, ?)');
        for (const row of rows) {
          let payload: unknown;
          try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
          const text = semanticText(row.type, payload);
          if (!text.trim()) continue;
          insert.run(row.session_id, row.seq, row.type, text);
        }
      });
      transaction();
      return;
    }
    // LIKE fallback has no derived table; search scans the source directly.
  }

  private snippet(text: string, query: string): string {
    const needle = query.trim().toLowerCase();
    const index = needle ? text.toLowerCase().indexOf(needle) : -1;
    if (index === -1) return text.slice(0, 240);
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + needle.length + 80);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return `${prefix}${text.slice(start, end).trim()}${suffix}`;
  }

  search(query: string, options: { limit?: number; offset?: number; sessionId?: string } = {}): SearchPage {
    const q = query.trim();
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const offset = Math.max(0, options.offset ?? 0);
    if (!q) return { hits: [], total: 0 };

    this.reconcile();
    const titles = new Map<string, string>();
    for (const session of this.sessions.list()) titles.set(session.id, session.title);

    if (this.useFts) {
      // Literal phrase as data: quote into one FTS5 phrase so query syntax stays inert.
      const phrase = q.replace(/"/g, '""');
      const match = `"${phrase}"`;
      const base = 'SELECT session_id, seq, type, text FROM session_search_fts WHERE session_search_fts MATCH ?';
      const sessionClause = options.sessionId ? ' AND session_id = ?' : '';
      const sql = `${base}${sessionClause} ORDER BY session_id, seq LIMIT ? OFFSET ?`;
      const params = options.sessionId ? [match, options.sessionId, limit, offset] : [match, limit, offset];
      const rows = this.db.prepare(sql).all(...params) as Array<{ session_id: string; seq: number; type: string; text: string }>;
      const totalRow = this.db.prepare(
        `SELECT COUNT(*) AS count FROM session_search_fts WHERE session_search_fts MATCH ?${sessionClause}`,
      ).get(...(options.sessionId ? [match, options.sessionId] : [match])) as { count: number };
      return {
        hits: rows.map((row) => ({
          sessionId: row.session_id,
          seq: row.seq,
          type: row.type,
          snippet: this.snippet(row.text, q),
          sessionTitle: titles.get(row.session_id) ?? '',
        })),
        total: totalRow.count,
      };
    }

    // LIKE fallback: case-insensitive substring scan of semantic text (not FTS token recall).
    const rows = this.db.prepare('SELECT session_id, seq, type, payload FROM session_events ORDER BY session_id, seq').all() as Array<{
      session_id: string; seq: number; type: string; payload: string;
    }>;
    const needle = q.toLowerCase();
    const matched: SearchHit[] = [];
    for (const row of rows) {
      if (options.sessionId && row.session_id !== options.sessionId) continue;
      let payload: unknown;
      try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
      const text = semanticText(row.type, payload);
      if (!text.toLowerCase().includes(needle)) continue;
      matched.push({
        sessionId: row.session_id,
        seq: row.seq,
        type: row.type,
        snippet: this.snippet(text, q),
        sessionTitle: titles.get(row.session_id) ?? '',
      });
    }
    return { hits: matched.slice(offset, offset + limit), total: matched.length };
  }

  /** Exact read: one session's events (live-preferred, detached clone). */
  readSession(sessionId: string) {
    return this.events.list(sessionId);
  }

  /** Literal text filter (whitespace-flexible substring, not ranked search). */
  filterEvents(sessionId: string, text: string) {
    const needle = text.trim().toLowerCase();
    return this.events.list(sessionId).filter((event) => {
      const semantic = semanticText(event.type, event.payload);
      return needle === '' || semantic.toLowerCase().includes(needle);
    });
  }
}
