import db from '../db';

export interface Message {
    role: 'user' | 'model';
    parts: { text: string }[];
    thought?: string;
    steps?: any[];
    calls?: any[];
}

export interface Session {
    id: string;
    projectId: string;
    title: string;
    lastUpdated: number;
    messages: Message[];
    isPinned?: boolean;
}

export interface Project {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
    lastActive: number;
}

export interface Note {
    id: string;
    title: string;
    content: string;
}

export class MemoryService {

    constructor() {
        // DB is initialized on import
    }

    // --- Projects ---
    createProject(name: string, description?: string): Project {
        const id = Math.random().toString(36).substr(2, 9);
        const now = Date.now();
        const project: Project = {
            id,
            name,
            description,
            createdAt: now,
            lastActive: now
        };

        db.prepare(`
            INSERT INTO projects (id, name, description, created_at, last_active)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, name, description || null, now, now);

        return project;
    }

    getProjects(): Project[] {
        const rows = db.prepare(`
            SELECT id, name, description, created_at as createdAt, last_active as lastActive
            FROM projects
            ORDER BY last_active DESC
        `).all();
        return rows as Project[];
    }

    deleteProject(id: string) {
        // Cascade delete handles sessions and messages
        db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }

    getDefaultProject(): Project {
        const projects = this.getProjects();
        if (projects.length > 0) {
            return projects[0];
        }
        return this.createProject('Default Project', 'Auto-created default project');
    }

    // --- Sessions ---
    createSession(projectId: string, title: string = "Thinking..."): Session {
        const id = Math.random().toString(36).substr(2, 9);
        const now = Date.now();
        const session: Session = {
            id,
            projectId,
            title,
            lastUpdated: now,
            messages: []
        };

        db.prepare(`
            INSERT INTO sessions (id, project_id, title, last_updated, is_pinned)
            VALUES (?, ?, ?, ?, 0)
        `).run(id, projectId, title, now);

        // Update project last active
        db.prepare('UPDATE projects SET last_active = ? WHERE id = ?').run(now, projectId);

        return session;
    }

    getSessionsByProject(projectId: string): Session[] {
        const sessions = db.prepare(`
            SELECT id, project_id as projectId, title, last_updated as lastUpdated, is_pinned as isPinned
            FROM sessions
            WHERE project_id = ?
            ORDER BY is_pinned DESC, last_updated DESC
        `).all(projectId) as any[];

        return sessions.map(s => ({
            ...s,
            isPinned: !!s.isPinned,
            messages: this.getHistory(s.id)
        }));
    }

    getAllSessions(): Session[] {
        const sessions = db.prepare(`
            SELECT id, project_id as projectId, title, last_updated as lastUpdated, is_pinned as isPinned
            FROM sessions
            ORDER BY last_updated DESC
        `).all() as any[];

        return sessions.map(s => ({
            ...s,
            isPinned: !!s.isPinned,
            messages: this.getHistory(s.id)
        }));
    }

    getSession(id: string): Session | undefined {
        const session = db.prepare(`
            SELECT id, project_id as projectId, title, last_updated as lastUpdated, is_pinned as isPinned
            FROM sessions
            WHERE id = ?
        `).get(id) as any;

        if (!session) return undefined;

        return {
            ...session,
            isPinned: !!session.isPinned,
            messages: this.getHistory(session.id)
        };
    }

    deleteSession(id: string) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }

    togglePin(id: string) {
        const session = db.prepare('SELECT is_pinned FROM sessions WHERE id = ?').get(id) as any;
        if (session) {
            const newPinned = session.is_pinned ? 0 : 1;
            db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ?').run(newPinned, id);
        }
    }

    addToHistory(role: 'user' | 'model', text: string, sessionId: string, calls?: any[], thought?: string, steps?: any[]) {
        const now = Date.now();

        // Insert message
        db.prepare(`
            INSERT INTO messages (session_id, role, content, thought, created_at, calls, steps)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sessionId, role, text, thought || null, now, calls ? JSON.stringify(calls) : null, steps ? JSON.stringify(steps) : null);

        // Update session last_updated
        db.prepare('UPDATE sessions SET last_updated = ? WHERE id = ?').run(now, sessionId);

        // Update project last_active
        const session = this.getSession(sessionId);
        if (session) {
            db.prepare('UPDATE projects SET last_active = ? WHERE id = ?').run(now, session.projectId);
        }
    }

    updateSessionTitle(sessionId: string, title: string) {
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
    }

    getHistory(sessionId: string): Message[] {
        const rows = db.prepare(`
            SELECT role, content, thought, steps, calls
            FROM messages
            WHERE session_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(sessionId) as any[];

        return rows.map(row => ({
            role: row.role as 'user' | 'model',
            parts: [{ text: row.content }],
            thought: row.thought || undefined,
            steps: row.steps ? JSON.parse(row.steps) : undefined,
            calls: row.calls ? JSON.parse(row.calls) : undefined
        }));
    }

    // --- Notes & Stats ---
    getNotes(): Note[] {
        return db.prepare('SELECT id, title, content FROM notes ORDER BY created_at DESC').all() as Note[];
    }

    addNote(title: string, content: string): Note {
        const id = Math.random().toString(36).substr(2, 9);
        db.prepare('INSERT INTO notes (id, title, content, created_at) VALUES (?, ?, ?, ?)').run(id, title, content, Date.now());
        return { id, title, content };
    }

    updateNote(id: string, title: string, content: string) {
        db.prepare('UPDATE notes SET title = ?, content = ? WHERE id = ?').run(title, content, id);
    }

    deleteNote(id: string) {
        db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    }

    getStats() {
        const projectCount = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c;
        const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c;
        const messageCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c;
        const noteCount = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as any).c;

        // File size approximation
        const fs = require('fs');
        const path = require('path');
        const getMemoryPath = () => {
            const appData = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + '/.local/share');
            return path.join(appData, 'MorphiIntelligence', 'morphi.db');
        };
        let fileSize = 0;
        try {
            fileSize = fs.statSync(getMemoryPath()).size;
        } catch (e) { }

        return {
            projectCount,
            sessionCount,
            messageCount,
            noteCount,
            fileSize
        };
    }

    clearAll() {
        db.transaction(() => {
            db.prepare('DELETE FROM messages').run();
            db.prepare('DELETE FROM sessions').run();
            db.prepare('DELETE FROM projects').run();
            db.prepare('DELETE FROM notes').run();
        })();
    }
}

export const memoryService = new MemoryService();

