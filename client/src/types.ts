export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  lastActive: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought?: string;        // The AI's pre-tool thinking
  timestamp?: number;
  isError?: boolean;       // True when the message IS an error (empty failed stream)
  errorNote?: string;      // Appended error note after partial stream
  calls?: {
    name: string;
    args: any;
    result?: string;
    status: 'running' | 'done' | 'error';
  }[];
  steps?: MessageStep[];
}

export type MessageStep =
  | { type: 'text', content: string }
  | { type: 'call', name: string, args: any, result?: string, status: 'running' | 'done' | 'error' }
  | { type: 'task', title: string, completed?: boolean };


export interface Session {
  id: string;
  projectId: string;
  title: string;
  lastUpdated: number;
  messages: Message[];
  isPinned?: boolean;
}

export interface Note {
  id: string;
  title: string;
  content: string;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  logo: string;
  description?: string;
  context?: number;
}

export interface StreamChunk {
  type: 'content' | 'error' | 'done' | 'call' | 'thought';
  content?: string;
  call?: {
    name: string;
    args: any;
    result?: string;
  };
}
