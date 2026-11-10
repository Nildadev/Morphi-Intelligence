import type Database from 'better-sqlite3';

export interface ProviderSetting {
  providerId: string;
  baseUrl?: string;
  enabled: boolean;
  updatedAt: number;
}

export interface ProviderSettingsPatch {
  /** `null` clears a stored value; `undefined` leaves it as it is. */
  baseUrl?: string | null;
  enabled?: boolean;
}

export interface ProviderSettingsStore {
  /** Provider rows only, so boot can replay them into `LlmRegistry` without phantom entries. */
  list(): ProviderSetting[];
  get(providerId: string): ProviderSetting | undefined;
  setConfig(providerId: string, patch: ProviderSettingsPatch): ProviderSetting;
}

/**
 * `provider_settings` is the harness's only key/value table, so the Settings MCP path is stored as
 * the `mcp` row (`base_url` holds the path). `list()` hides those rows: feeding `mcp` to
 * `LlmRegistry.setProviderConfig` would surface a provider that does not exist in
 * `GET /api/providers`. Retired providers (proxypal) are hidden for the same reason: a stored row
 * must not resurrect a card after the adapter was removed.
 */
const NON_PROVIDER_ROWS = new Set(['mcp', 'proxypal']);

interface SettingRow {
  provider_id: string;
  base_url: string | null;
  enabled: number;
  updated_at: number;
}

function toSetting(row: SettingRow): ProviderSetting {
  return {
    providerId: row.provider_id,
    baseUrl: row.base_url ?? undefined,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

export function createProviderSettingsStore(db: Database.Database): ProviderSettingsStore {
  const select = (id: string): SettingRow | undefined =>
    db.prepare('SELECT provider_id, base_url, enabled, updated_at FROM provider_settings WHERE provider_id = ?').get(id) as
      | SettingRow
      | undefined;

  return {
    list() {
      const rows = db
        .prepare('SELECT provider_id, base_url, enabled, updated_at FROM provider_settings ORDER BY updated_at ASC')
        .all() as SettingRow[];
      return rows.filter((row) => !NON_PROVIDER_ROWS.has(row.provider_id)).map(toSetting);
    },

    get(providerId) {
      const row = select(providerId);
      return row ? toSetting(row) : undefined;
    },

    setConfig(providerId, patch) {
      const previous = select(providerId);
      const baseUrl = patch.baseUrl === undefined ? previous?.base_url ?? null : patch.baseUrl;
      const enabled = patch.enabled === undefined ? (previous?.enabled ?? 1) : patch.enabled ? 1 : 0;
      const updatedAt = Date.now();

      db.prepare(
        `INSERT INTO provider_settings (provider_id, base_url, enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET base_url = excluded.base_url, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      ).run(providerId, baseUrl, enabled, updatedAt);

      return { providerId, baseUrl: baseUrl ?? undefined, enabled: enabled === 1, updatedAt };
    },
  };
}
