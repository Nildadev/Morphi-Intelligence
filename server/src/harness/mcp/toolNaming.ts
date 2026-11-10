/**
 * Task 31B — namespace + policy for the official Studio MCP tool surface.
 *
 * M8 (measured): the server exposes `skill`, `subagent`, `create_skill`, `edit_skill`, `list_skills`,
 * `http_get`, `search_game_tree`, `script_read` — names Morphi also uses for its own built-ins.
 * Every MCP tool is therefore published as `studio.<serverName>`, and the reverse mapping is the
 * only place that knows about the prefix.
 *
 * Step 7: risk/approval comes from an explicit table, never from a prefix guess. `get_console_output`
 * is safe, `execute_luau` is arbitrary code; both are `get_`/verb-shaped. An unknown upstream tool
 * fails safe (`ask` / medium) instead of being auto-approved.
 */
export const STUDIO_TOOL_PREFIX = 'studio.';

export type StudioRisk = 'low' | 'medium' | 'high';
export type StudioApproval = 'auto' | 'ask' | 'ask-once';

export interface StudioToolPolicy {
  label: string;
  risk: StudioRisk;
  approval: StudioApproval;
  /**
   * Characters this tool may return, when it measured a result too large to spend on one call
   * (Task 31C). Absent means "whatever the turn's window allows".
   */
  maxOutputChars?: number;
}

/** Measured live on 2026-11-05 (35 tools; `open_cloud_invoke` was added after the 03-11 probe). */
export const STUDIO_TOOL_NAMES = [
  'auto_setup_avatar',
  'character_navigation',
  'create_skill',
  'edit_skill',
  'execute_luau',
  'generate_avatar',
  'generate_material',
  'generate_mesh',
  'generate_procedural_model',
  'generate_scene',
  'generate_texture',
  'get_console_output',
  'get_studio_state',
  'http_get',
  'insert_asset',
  'inspect_instance',
  'list_roblox_studios',
  'list_skills',
  'multi_edit',
  'open_cloud_invoke',
  'screen_capture',
  'script_grep',
  'script_read',
  'script_search',
  'search_asset',
  'search_game_tree',
  'segment_mesh',
  'skill',
  'start_stop_play',
  'store_image',
  'subagent',
  'upload_image',
  'user_keyboard_input',
  'user_mouse_input',
  'wait_job_finished',
] as const;

const AUTO_LOW = { approval: 'auto', risk: 'low' } as const;
const ASK_MEDIUM = { approval: 'ask', risk: 'medium' } as const;
const ASK_HIGH = { approval: 'ask', risk: 'high' } as const;

const POLICY: Record<string, StudioToolPolicy> = {
  // Read-only inspection: safe to run without a prompt.
  list_roblox_studios: { label: 'Liệt kê Studio', ...AUTO_LOW },
  get_studio_state: { label: 'Đọc trạng thái Studio', ...AUTO_LOW },
  get_console_output: { label: 'Đọc console', ...AUTO_LOW },
  inspect_instance: { label: 'Soi instance', ...AUTO_LOW },
  // 22 803 chars on an empty place, capped by Studio at 200 nodes; 8k is ~2k tokens of tree.
  search_game_tree: { label: 'Tìm trong cây game', ...AUTO_LOW, maxOutputChars: 8_000 },
  script_read: { label: 'Đọc script', ...AUTO_LOW },
  // Measured live on Place1 (2026-11-06): these answer with whole trees/directories, not a value.
  script_search: { label: 'Tìm script', ...AUTO_LOW, maxOutputChars: 8_000 },
  script_grep: { label: 'Grep script', ...AUTO_LOW, maxOutputChars: 8_000 },
  search_asset: { label: 'Tìm asset', ...AUTO_LOW, maxOutputChars: 6_000 },
  // 8 786 chars of skill text / 7 067 chars of index, both measured live.
  skill: { label: 'Tra skill', ...AUTO_LOW, maxOutputChars: 8_000 },
  list_skills: { label: 'Liệt kê skill', ...AUTO_LOW, maxOutputChars: 6_000 },
  http_get: { label: 'Tải URL', ...AUTO_LOW },
  screen_capture: { label: 'Chụp màn hình Studio', ...AUTO_LOW },
  wait_job_finished: { label: 'Chờ job', ...AUTO_LOW },

  // Mutating the open place: always ask, medium risk.
  multi_edit: { label: 'Sửa nhiều đoạn script', ...ASK_MEDIUM },
  insert_asset: { label: 'Chèn asset', ...ASK_MEDIUM },
  start_stop_play: { label: 'Chạy/dừng play', ...ASK_MEDIUM },
  character_navigation: { label: 'Điều hướng nhân vật', ...ASK_MEDIUM },
  user_mouse_input: { label: 'Gửi chuột', ...ASK_MEDIUM },
  user_keyboard_input: { label: 'Gửi phím', ...ASK_MEDIUM },
  auto_setup_avatar: { label: 'Tạo rig avatar', ...ASK_MEDIUM },
  subagent: { label: 'Chạy subagent', ...ASK_MEDIUM },
  create_skill: { label: 'Tạo skill', ...ASK_MEDIUM },
  edit_skill: { label: 'Sửa skill', ...ASK_MEDIUM },

  // Arbitrary code, publishing, uploading, generation cost: ask + high.
  execute_luau: { label: 'Chạy Luau', ...ASK_HIGH },
  upload_image: { label: 'Tải ảnh lên', ...ASK_HIGH },
  store_image: { label: 'Lưu ảnh', ...ASK_HIGH },
  generate_avatar: { label: 'Tạo avatar', ...ASK_HIGH },
  generate_material: { label: 'Tạo material', ...ASK_HIGH },
  generate_mesh: { label: 'Tạo mesh', ...ASK_HIGH },
  generate_procedural_model: { label: 'Tạo model thủ tục', ...ASK_HIGH },
  generate_scene: { label: 'Tạo scene', ...ASK_HIGH },
  generate_texture: { label: 'Tạo texture', ...ASK_HIGH },
  segment_mesh: { label: 'Tách mesh', ...ASK_HIGH },
  open_cloud_invoke: { label: 'Gọi cloud', ...ASK_HIGH },
};

export function policyFor(serverName: string): StudioToolPolicy {
  return POLICY[serverName] ?? { label: serverName, risk: 'medium', approval: 'ask' };
}

/** Public (advertised + registry) name for a server tool. */
export function mcpToolName(serverName: string): string {
  return serverName.startsWith(STUDIO_TOOL_PREFIX) ? serverName : `${STUDIO_TOOL_PREFIX}${serverName}`;
}

/** Server name for a public tool name. Non-studio names pass through untouched. */
export function serverToolName(publicName: string): string {
  return publicName.startsWith(STUDIO_TOOL_PREFIX) ? publicName.slice(STUDIO_TOOL_PREFIX.length) : publicName;
}
