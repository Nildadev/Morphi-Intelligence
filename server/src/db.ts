import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Project, Session, Message } from './services/MemoryService';

// Determine storage path
const getAppDataPath = () => {
    const appData = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + '/.local/share');
    const morphiDir = path.join(appData, 'MorphiIntelligence');

    if (!fs.existsSync(morphiDir)) {
        try {
            fs.mkdirSync(morphiDir, { recursive: true });
        } catch (e) {
            return process.cwd();
        }
    }
    return morphiDir;
};

const DB_PATH = path.join(getAppDataPath(), 'morphi.db');
const MEMORY_JSON_PATH = path.join(getAppDataPath(), 'memory.json');

const db = new Database(DB_PATH);
// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');

// Initialize Schema
const initSchema = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            created_at INTEGER NOT NULL,
            last_active INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT,
            last_updated INTEGER NOT NULL,
            is_pinned INTEGER DEFAULT 0,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            thought TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            steps TEXT, -- JSON string
            calls TEXT, -- JSON string
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        );
    `);

    // Migration: Add thought column if missing
    try {
        db.exec("ALTER TABLE messages ADD COLUMN thought TEXT;");
    } catch {
        // Column probably already exists
    }
};

// Migration from memory.json
const migrateFromJSON = () => {
    // Check various locations for memory.json just in case
    let jsonPath = MEMORY_JSON_PATH;
    if (!fs.existsSync(jsonPath)) {
        // Fallback to local if AppData one doesn't exist
        const localPath = path.join(process.cwd(), 'memory.json');
        if (fs.existsSync(localPath)) {
            jsonPath = localPath;
        } else {
            return; // No migration needed
        }
    }

    try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);

        console.log(`[DB] Migrating data from ${jsonPath}...`);

        const insertProject = db.prepare(`
            INSERT OR IGNORE INTO projects (id, name, description, created_at, last_active)
            VALUES (?, ?, ?, ?, ?)
        `);

        const insertSession = db.prepare(`
            INSERT OR IGNORE INTO sessions (id, project_id, title, last_updated, is_pinned)
            VALUES (?, ?, ?, ?, ?)
        `);

        const insertMessage = db.prepare(`
            INSERT INTO messages (session_id, role, content, created_at, steps, calls)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertNote = db.prepare(`
            INSERT OR IGNORE INTO notes (id, title, content, created_at)
            VALUES (?, ?, ?, ?)
        `);

        const transaction = db.transaction(() => {
            // Migrate Projects
            if (data.projects) {
                for (const p of Object.values(data.projects) as Project[]) {
                    insertProject.run(p.id, p.name, p.description || null, p.createdAt || Date.now(), p.lastActive || Date.now());
                }
            }

            // Migrate Sessions & Messages
            if (data.sessions) {
                for (const s of Object.values(data.sessions) as Session[]) {
                    insertSession.run(s.id, s.projectId, s.title, s.lastUpdated || Date.now(), s.isPinned ? 1 : 0);

                    if (s.messages && Array.isArray(s.messages)) {
                        for (const m of s.messages) {
                            const text = m.parts?.[0]?.text || '';
                            // Assuming messages are in chronological order, we can approximate created_at
                            // Or just use current time if not available.
                            // Since old format didn't have timestamp per message, we use session's lastUpdated for simplicity or just current.
                            // Ideally, we space them out slightly to keep order.
                            insertMessage.run(
                                s.id,
                                m.role,
                                text,
                                Date.now(),
                                m.steps ? JSON.stringify(m.steps) : null,
                                m.calls ? JSON.stringify(m.calls) : null
                            );
                        }
                    }
                }
            }

            // Migrate Notes
            if (data.notes && Array.isArray(data.notes)) {
                for (const n of data.notes) {
                    insertNote.run(n.id, n.title, n.content, Date.now());
                }
            }
        });

        transaction();
        console.log("[DB] Migration completed successfully.");

        // Rename old file
        fs.renameSync(jsonPath, jsonPath + '.migrated');
        console.log(`[DB] Renamed ${jsonPath} to ${jsonPath}.migrated`);

    } catch (error) {
        console.error("[DB] Migration failed:", error);
    }
};

// Run initialization
initSchema();
migrateFromJSON();

export default db;
