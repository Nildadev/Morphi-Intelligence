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
  timestamp?: number;
  isError?: boolean;       // True when the message IS an error (empty failed stream)
  errorNote?: string;      // Appended error note after partial stream
  calls?: {
    name: string;
    args: any;
    result?: string;
    status: 'running' | 'done' | 'error';
  }[];
}

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
  type: 'content' | 'error' | 'done' | 'call';
  content?: string;
  call?: {
    name: string;
    args: any;
    result?: string;
  };
}
