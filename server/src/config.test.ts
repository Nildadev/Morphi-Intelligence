import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses electron defaults for port and token mode', () => {
    const config = loadConfig({ MORPHI_MODE: 'electron', MORPHI_TOKEN: 'abc', APPDATA: 'C:/data' });
    expect(config.port).toBe(0);
    expect(config.token).toBe('abc');
    expect(config.isDev).toBe(false);
  });

  it('uses dev token and port 3000 outside electron', () => {
    const config = loadConfig({ APPDATA: 'C:/data' });
    expect(config.port).toBe(3000);
    expect(config.token).toBe('dev-token');
    expect(config.isDev).toBe(true);
  });

  it('defaults auto priority to the built-in lineup without proxypal', () => {
    const config = loadConfig({ APPDATA: 'C:/data' });
    expect(config.autoPriority).toEqual([
      'google', 'openai', 'anthropic', 'openrouter', 'deepseek', 'deepseek-chat', 'groq', 'mistral', 'xai', 'cerebras', 'together', 'fireworks', 'perplexity', 'deepinfra', 'nvidia', 'kilo', 'custom',
    ]);
  });
});
