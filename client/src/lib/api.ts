import type { Model, Session, Note, StreamChunk, Project } from '../types';

const API_BASE = 'http://localhost:3000/api';

export const api = {
  // --- Projects ---
  async getProjects(): Promise<Project[]> {
    const res = await fetch(`${API_BASE}/projects`);
    if (!res.ok) throw new Error('Failed to fetch projects');
    return res.json();
  },

  async createProject(name: string, description?: string): Promise<Project> {
    const res = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    return res.json();
  },

  async deleteProject(id: string): Promise<void> {
    await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
  },

  // --- Models ---
  async getModels(refresh: boolean = false): Promise<Model[]> {
    const res = await fetch(`${API_BASE}/models?refresh=${refresh}`);
    if (!res.ok) throw new Error('Failed to fetch models');
    return res.json();
  },

  // --- Sessions ---
  async getSessions(projectId?: string): Promise<Session[]> {
    const url = projectId ? `${API_BASE}/sessions?projectId=${projectId}` : `${API_BASE}/sessions`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch sessions');
    const sessions = await res.json();
    return sessions.map((s: any) => ({
      ...s,
      messages: (s.messages || []).map((m: any) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: m.content || (m.parts && m.parts[0] ? m.parts[0].text : '') || '',
        thought: m.thought,
        calls: (m.calls || []).map((c: any) => ({
          ...c,
          status: c.result ? 'done' : 'running'
        }))
      }))
    }));
  },

  async createSession(projectId: string, title: string): Promise<Session> {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, title })
    });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
  },

  async deleteSession(id: string): Promise<void> {
    await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
  },

  async togglePin(id: string): Promise<void> {
    await fetch(`${API_BASE}/sessions/${id}/pin`, { method: 'POST' });
  },

  async streamChat(
    message: string,
    sessionId: string,
    modelId: string,
    extendedThinking: boolean = false,
    onChunk: (chunk: string) => void,
    onThought: (thought: string) => void,
    onCall: (call: { name: string, args: any, result?: string }) => void,
    onDone: () => void,
    onError: (err: string) => void,
    signal?: AbortSignal
  ) {
    try {
      const response = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId, model: modelId, extendedThinking }),
        signal
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errData.error || 'Server error');
      }

      if (!response.body) throw new Error('No response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') { onDone(); return; }
          try {
            const data: StreamChunk = JSON.parse(jsonStr);
            if (data.type === 'content' && data.content) onChunk(data.content);
            else if (data.type === 'thought' && data.content) onThought(data.content);
            else if (data.type === 'call' && data.call) onCall(data.call);
            else if (data.type === 'done') { onDone(); return; }
            else if (data.type === 'error') throw new Error(data.content || 'Unknown error');
          } catch (e) { console.warn('Failed to parse chunk', e); }
        }
      }
      onDone();
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      onError(error.message || 'Connection lost');
    }
  },

  // --- Settings & Notes ---
  async updateKey(providerId: string, apiKey: string): Promise<void> {
    await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, apiKey })
    });
  },
  async getNotes(): Promise<Note[]> {
    const res = await fetch(`${API_BASE}/notes`);
    return res.ok ? res.json() : [];
  },
  async createNote(title: string, content: string): Promise<Note> {
    const res = await fetch(`${API_BASE}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });
    return res.json();
  }
};