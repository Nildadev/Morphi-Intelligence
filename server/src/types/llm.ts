export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: string[]; // Base64 strings
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

export interface LLMProvider {
  id: string;
  name: string;
  configure(apiKey: string): void;
  getModels(): Promise<Model[]>;
  chat(messages: Message[], modelId: string, options?: any): AsyncGenerator<StreamChunk>;
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
