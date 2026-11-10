import type Database from 'better-sqlite3';
import type { NewSessionEvent, SessionEvent } from './types';

export class EventStore {
  constructor(private db: Database.Database) {}

  append(sessionId: string, events: NewSessionEvent[]): SessionEvent[] {
    const insert = this.db.prepare('INSERT INTO session_events (session_id, seq, type, payload, schema_version, created_at) VALUES (?, ?, ?, ?, 1, ?)');
    const update = this.db.prepare('UPDATE sessions SET last_updated = ? WHERE id = ?');
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?');
    return this.db.transaction(() => {
      const start = (next.get(sessionId) as { seq: number }).seq;
      const now = Date.now();
      const rows = events.map((event, index) => {
        const seq = start + index + 1;
        const result = insert.run(sessionId, seq, event.type, JSON.stringify(event.payload), now);
        return { id: Number(result.lastInsertRowid), sessionId, seq, type: event.type, payload: event.payload, schemaVersion: 1 as const, createdAt: now };
      });
      update.run(now, sessionId);
      return rows;
    })();
  }

  list(sessionId: string, afterSeq = 0): SessionEvent[] {
    const rows = this.db.prepare('SELECT id, session_id, seq, type, payload, schema_version, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC').all(sessionId, afterSeq) as any[];
    return rows.map((row) => ({ id: row.id, sessionId: row.session_id, seq: row.seq, type: row.type, payload: JSON.parse(row.payload), schemaVersion: row.schema_version, createdAt: row.created_at }));
  }

  /** Copy a durable prefix into another session log (branch/redo). Returns the copied rows. */
  copy(sourceSessionId: string, targetSessionId: string, upToSeq: number): SessionEvent[] {
    const rows = this.db.prepare('SELECT type, payload, schema_version, created_at FROM session_events WHERE session_id = ? AND seq <= ? AND type != \'session/created\' ORDER BY seq ASC').all(sourceSessionId, upToSeq) as any[];
    const events = rows.map((row) => ({
      type: row.type,
      payload: JSON.parse(row.payload),
    }));
    return this.append(targetSessionId, events as NewSessionEvent[]);
  }
}
