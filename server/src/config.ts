import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeConfig {
  token: string;
  port: number;
  dbPath: string;
  clientDistPath: string;
  isDev: boolean;
  titleModel: string;
  autoPriority: string[];
  compaction: { pruneAt: number; summarizeAt: number; keepRecentTurns: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const electron = env.MORPHI_MODE === 'electron';
  const appData = env.APPDATA || path.join(env.HOME || process.cwd(), '.local', 'share');
  const settingsPath = path.join(appData, 'MorphiIntelligence', 'settings.json');
  let settings: any = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* defaults */ }
  return {
    token: env.MORPHI_TOKEN || (electron ? '' : 'dev-token'),
    port: Number(env.MORPHI_PORT ?? (electron ? 0 : 3000)),
    dbPath: env.MORPHI_DB_PATH || path.join(appData, 'MorphiIntelligence', 'morphi.db'),
    clientDistPath: path.join(__dirname, '../../client/dist'),
    isDev: !electron,
    titleModel: env.MORPHI_TITLE_MODEL || settings.titleModel || 'auto',
    autoPriority: settings.autoPriority || ['google', 'openai', 'anthropic', 'openrouter', 'deepseek', 'deepseek-chat', 'deepseek-web', 'groq', 'mistral', 'xai', 'cerebras', 'together', 'fireworks', 'perplexity', 'deepinfra', 'nvidia', 'kilo', 'custom'],
    compaction: {
      pruneAt: settings.compaction?.pruneAt ?? 0.7,
      summarizeAt: settings.compaction?.summarizeAt ?? 0.85,
      keepRecentTurns: settings.compaction?.keepRecentTurns ?? 6,
    },
  };
}
