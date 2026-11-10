import type Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT,
      created_at INTEGER NOT NULL,
      last_updated INTEGER NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      model_selection TEXT,
      goal_id TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_updated DESC);

    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(session_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, seq);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

    CREATE TABLE IF NOT EXISTS provider_settings (
      provider_id TEXT PRIMARY KEY,
      base_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      label TEXT,
      base_event_seq INTEGER,
      root_hash TEXT NOT NULL,
      manifest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recorded'
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON workspace_checkpoints(session_id, created_at DESC);
  `);

  // DBs created before subagent-as-child had these columns — add them idempotently.
  // `ALTER TABLE ADD COLUMN` throws when the column exists, so probe `PRAGMA table_info`.
  const columns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has('is_subagent')) db.exec('ALTER TABLE sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('parent_session_id')) db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');

  db.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1')").run();
}
