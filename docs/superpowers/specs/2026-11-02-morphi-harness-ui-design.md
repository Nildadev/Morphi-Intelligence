# Morphi Intelligence — Harness & UI Redesign Spec

- **Ngày:** 2026-11-02
- **Trạng thái:** Chờ người dùng review
- **Phiên bản mục tiêu:** 1.1.0
- **Phạm vi:** AI harness, UI ChatGPT desktop, bug fixes, security, cleanup, testing

---

## 1. Bối cảnh

Morphi Intelligence hiện là Electron app gồm:

- Electron main nhúng Express server và mở UI tại `localhost:3000`.
- React 19 + Vite + Tailwind 4 cho giao diện chat.
- SQLite (`better-sqlite3`) lưu project/session/message.
- Provider OpenAI, Gemini, OpenRouter, ProxyPal; stream SSE; vòng lặp tool call tối đa 10 vòng.
- Roblox Studio MCP hiện chạy qua `npx -y robloxstudio-mcp@latest` (package bên thứ ba `boshyxd/robloxstudio-mcp`); 1.1.0 chuyển sang **MCP server chính thức của Roblox** (xem §4.11).

Các vấn đề chính đã xác định:

1. SSE error bị catch và nuốt, người dùng chỉ thấy message rỗng.
2. Tin nhắn đầu tiên fail trên DB trống do dùng stale `currentProjectId`.
3. Stop chỉ abort fetch, agent/tool ở server vẫn tiếp tục chạy.
4. Regenerate append trùng user message vào history.
5. `thought` và `steps` được thu thập nhưng không truyền xuống UI.
6. Settings quảng cáo connector provider nhưng backend không hỗ trợ.
7. API key lưu localStorage, không được backend nạp lại sau restart.
8. Server bind mọi interface, CORS mở, không auth.
9. Model mặc định và title generation hardcode `gemini-1.5-flash`.
10. Server chạy trong Electron main process; uncaught exception có thể giết cả app.
11. Session list load toàn bộ history của mọi session (N+1).
12. Repo còn binary không rõ nguồn gốc, build log cũ, code chết, không có test.

Tham chiếu thiết kế: `deepseek-ai/deepseek-harness` (`dsh`). Morphi học các pattern sau, **không** phụ thuộc runtime Cordis:

- Append-only session event log là nguồn sự thật.
- Tool registry + pipeline pre/execute/post + approval policy.
- Agent loop turn/step với cancellation, retry, checkpoint.
- Prompt assembly từ sections + tool schemas động.
- Context compaction bằng prune + summary.
- Plugin/service seam, subagents, skills, goals, workflows.

---

## 2. Mục tiêu và ngoài phạm vi

### 2.1 Mục tiêu

1. Xây harness nội bộ đầy đủ cho use case Roblox: event log, tool pipeline, agent loop, prompt assembly, compaction, approval, provider seam, plugin registry.
2. Thêm subagents, skills, goals, workflows có UI tương ứng.
3. Thiết kế lại UI rất sát ChatGPT desktop trong ảnh tham chiếu, Việt hóa, light mặc định + dark toggle.
4. Sửa toàn bộ lỗi P0/P1 đã liệt kê.
5. Siết bảo mật cho app local: loopback, token, CSP, safeStorage, approval.
6. Dọn sạch repo, thêm test, CI, LICENSE, tài liệu.
7. Đóng gói portable ổn định, không phụ thuộc Node cài sẵn trên máy người dùng.

### 2.2 Ngoài phạm vi 1.1.0

- Browser-use, computer-use, scheduled jobs, agent teams, SSH/remote workspace.
- Marketplace plugin bên thứ ba hoặc tải plugin không tin cậy.
- Custom workflow editor; chỉ có workflow built-in.
- Voice input, file/image attachment, multi-user/cloud sync.
- Mobile/web deployment ngoài Electron.

Các mục trên có thể là phiên bản sau nhưng kiến trúc seam phải cho phép mở rộng.

---

## 3. Quyết định đã chốt

| Quyết định | Giá trị |
|---|---|
| Mức harness | Full harness nội bộ, không phụ thuộc `dsh` runtime |
| UI | Rất sát ChatGPT desktop, Việt hóa; không copy tab Chat/Work và usage card |
| Dữ liệu cũ | Cho phép reset DB; DB cũ được đổi tên thành `morphi.db.v1.bak`, không xoá |
| Credential | Electron main sở hữu `safeStorage`; renderer ↔ main qua IPC; server nhận key qua `parentPort` |
| Server | Chạy trong `utilityProcess` riêng, bind `127.0.0.1`, port động |
| API | UI gọi relative `/api`; token do preload cấp, gửi qua header mỗi request |
| MCP | Chỉ dùng MCP server chính thức của Roblox (§4.11); bỏ package bên thứ ba, bỏ pin và bundle `robloxstudio-mcp` |
| Binary rác | Xoá `Morphi.exe` (đã được duyệt) |
| Build log | Xoá `build_log.txt`, `build_log_final.txt` (đã được duyệt) |
| Version | `1.1.0` cho root/client/server |
| External plugins | Chưa hỗ trợ trong 1.1.0; registry nội bộ là nền tảng |

---

## 4. Kiến trúc mục tiêu

### 4.1 Runtime topology

```
Electron main
  ├─ single-instance lock
  ├─ token + safeStorage owner (credentials IPC)
  ├─ utilityProcess.fork(server/dist/index.js)
  │    ├─ Express (127.0.0.1, port 0 → báo port về main)
  │    ├─ harness runtime
  │    ├─ SQLite (%APPDATA%/MorphiIntelligence/morphi.db)
  │    └─ MCP child process (Roblox Studio MCP chính thức, §4.11)
  └─ BrowserWindow → http://127.0.0.1:<port>
```

- Server listen port `0`, báo port thật về main qua `parentPort`; renderer không hardcode port.
- Main tạo token ngẫu nhiên mỗi lần chạy và truyền cho server qua env; preload expose token cho renderer qua `contextBridge`. API yêu cầu header `X-Morphi-Token`; token không xuất hiện trong URL/log.
- Key được main mã hoá/giải mã bằng `safeStorage`; main gửi key đã giải mã cho server qua `parentPort` khi boot và mỗi lần thay đổi. Server không đọc/ghi file key.
- Nếu utility process crash, main log, hiển thị dialog và restart tối đa 3 lần.
- Single-instance lock tránh hai app tranh port/DB.
- Dev không có Electron main: dùng `.env`; thay đổi key trong Settings chỉ có hiệu lực trong phiên và UI hiện cảnh báo.

### 4.2 Module layout

```
server/src/
  harness/
    events/
      types.ts            # SessionEventMap, event envelope
      store.ts            # append/read/stream
    session/
      store.ts            # create/open/list/summary
      projections.ts      # deriveMessages, deriveSteps, turnBoundary
      title.ts            # title service
    tools/
      definition.ts       # ToolDefinition, schema types
      registry.ts         # scoped registry
      pipeline.ts         # pre/execute/post, approval, concurrency
      builtins/
        todo.ts
        lint.ts
    agent/
      loop.ts             # turn/step state machine
      inbox.ts
      cancellation.ts
      retry.ts
    prompt/
      assemble.ts
      sections.ts
    llm/
      types.ts            # StreamEvent vocabulary
      registry.ts         # provider adapters
      adapters/
        openai.ts
        gemini.ts
        openrouter.ts
        proxypal.ts
        generic-openai.ts
    compaction/
      estimator.ts
      pruner.ts
      summarizer.ts
    plugins/
      registry.ts         # HarnessPlugin, HarnessContext
      index.ts            # thứ tự load plugin cố định
    subagents/
      runtime.ts
    skills/
      loader.ts
      builtin/
    goals/
      service.ts
    workflows/
      engine.ts
      builtin/
    auth/
      token.ts
      policy.ts
    logging.ts
  routes/                 # thin HTTP adapters
  index.ts
```

Quy tắc:

- Route không chứa business logic; mọi thao tác đi qua harness service.
- Event log là nguồn sự thật. Projection được phép cache nhưng phải rebuild được.
- Không import ngược từ harness sang route.
- Mỗi module có test riêng.

### 4.3 SQLite schema

DB reset được phép. Schema mới:

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  created_at INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  model_selection TEXT,
  goal_id TEXT
);
CREATE INDEX idx_sessions_project ON sessions(project_id, last_updated DESC);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX idx_events_session ON session_events(session_id, seq);

CREATE TABLE provider_settings (
  provider_id TEXT PRIMARY KEY,
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

- `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`.
- `sessions.goal_id` là cache con trỏ; trạng thái goal derive từ event `goal/changed`, không có bảng `goals` riêng.
- Lần đầu chạy 1.1.0: nếu phát hiện schema legacy (`messages` table), đổi tên file DB thành `morphi.db.v1.bak` rồi tạo DB mới; hiển thị thông báo cho người dùng.
- API key không nằm trong SQLite. Chỉ lưu trạng thái provider trong `provider_settings`.
- `session_events.payload` là JSON object; mọi event có `schemaVersion: 1`.
- Append dùng transaction tăng `seq`; không UPDATE/DELETE event, ngoại trừ xoá cả session/project theo cascade.

### 4.4 Event vocabulary

**Durable events** (ghi vào log):

| Type | Payload chính |
|---|---|
| `session/created` | `projectId`, `title`, `modelSelection` |
| `session/title` | `title`, `source` |
| `session/skills` | `skills` |
| `turn/start` | `turnId`, `modelSelection`, `trigger`, optional `regeneratedFrom` |
| `step/start` | `stepId`, `index` |
| `user/message` | `messageId`, `content`, `source` (user/steer) |
| `assistant/message` | `messageId`, `content`, `reasoning?`, `finishReason`, `usage`, `callIds` |
| `assistant/attempt` | `attemptId`, `error`, `retryable`, `finishedAt` |
| `tool/call` | `callId`, `name`, `args`, `startedAt` |
| `tool/result` | `callId`, `status` (`done`/`error`/`cancelled`), `result`, `durationMs` |
| `approval/request` | `approvalId`, `callId`, `name`, `args`, `risk` |
| `approval/decision` | `approvalId`, `decision` (`allow`/`deny`/`expired`), `scope` |
| `compaction/summary` | `summary`, `coveredFrom`, `coveredTo`, `tokenEstimate` |
| `turn/end` | `turnId`, `reason` (`completed`/`cancelled`/`max_steps`/`error`) |
| `goal/changed` | `goalId`, `status`, `objective` |
| `subagent/start` | `subagentId`, `parentSessionId`, `childSessionId`, `task` |
| `subagent/end` | `subagentId`, `status`, `summary` |
| `workflow/start` | `workflowId`, `name`, `phases` |
| `workflow/phase` | `workflowId`, `phase`, `status` |
| `workflow/end` | `workflowId`, `status` |

**Live events** (không ghi log, chỉ SSE):

- `assistant/delta`: `{ turnId, text }`
- `thought/delta`: `{ turnId, text }`
- `tool/progress`: `{ callId, message }`
- `agent/status`: `{ state, turnId }`
- `mcp/status`: `{ connected, studioLinked }`
- `error`: `{ code, message, retryable }`

Quy tắc derive:

- `deriveMessages(sessionId)` bỏ qua `assistant/attempt`, dựng tool_calls từ `tool/call` + `tool/result`, chèn `compaction/summary` như system context trước các event chưa được tóm tắt.
- `deriveSteps(sessionId)` trả timeline text/call/approval/task theo đúng thứ tự event.
- Retry không tạo user message mới.
- Regenerate append turn mới với `regeneratedFrom = { userMessageId, supersedesAssistantMessageId }`; không append lại user message; projection ẩn assistant message bị thay thế.

### 4.5 Tool pipeline

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
  timeoutMs?: number;
  isConcurrencySafe: boolean;
  approval: 'auto' | 'ask' | 'ask-once';
  presentation: { label: string; icon?: string; risk?: 'low' | 'medium' | 'high' };
}
```

- Registry scoped theo agent/step; `schemas()` chỉ trả field model-facing.
- Built-in tools 1.1.0: `todo_write`, `lint_luau`.
- MCP tools giữ nguyên tên gốc; label UI map sang tiếng Việt.
- Pipeline:
  1. `pre-execute`: validate JSON Schema, check cancellation, resolve approval.
  2. `execute`: chạy với `AbortSignal`, timeout, giới hạn output 50.000 ký tự.
  3. `post-execute`: ghi `tool/result`, audit, presentation metadata.
- Concurrency: tool `isConcurrencySafe` chạy pool tối đa 4; tool ghi chạy tuần tự theo barrier và theo model order.
- Approval mặc định:
  - `auto`: tool đọc (`get_*`, `search_*`, `list_*`, `lint_luau`, `todo_write`).
  - `ask`: tool ghi/thực thi (`set_*`, `create_*`, `delete_*`, `insert_*`, `edit_*`, `execute_luau`, `start_playtest`, `run_command`).
  - `ask-once`: cho phép trong phiên sau lần approve đầu tiên, trừ tool `high` risk luôn `ask`.
- Timeout mặc định 60s; MCP tool 120s; approval timeout 120s → `expired` = deny.
- Tool lỗi/bị huỷ vẫn phải có `tool/result` tương ứng.

### 4.6 Agent loop

State machine:

```
idle → turn/start → [step/start → assistant stream → tool calls → step/end]* → turn/end → idle
```

- Mỗi step: một model request + tối đa một batch tool call.
- Turn: tối đa 24 steps; mỗi step tối đa 8 tool calls; parallel pool 4.
- Retry provider: tối đa 10 lần cho 429/5xx/timeout, backoff 500ms → 1s → 2s → 4s → 8s → 16s → 30s (giữ nguyên 30s cho 4 lần cuối); không retry 4xx.
- Cancellation:
  - `AbortController` từ HTTP request, endpoint `/api/chat/cancel`, hoặc Stop button.
  - Provider stream dừng ngay; tool đang chạy nhận signal; tool chưa chạy ghi `cancelled`.
  - Ghi `assistant/attempt` nếu có partial text; `turn/end` reason `cancelled`.
- Inbox: user gửi thêm khi agent đang chạy được queue; xử lý ở step boundary kế tiếp. Nếu turn đã kết thúc, mở turn mới.
- Turn limit/timeout: 10 phút; vượt → `turn/end` reason `error` với code `TURN_TIMEOUT`.
- Mọi chuyển trạng thái phát live `agent/status` và durable event tương ứng.

### 4.7 Prompt assembly

Thứ tự sections:

1. Identity: Morphi AI, Roblox Luau architect.
2. Safety & style: luật Luau, không global, `task.wait`, disconnect events.
3. Environment: MCP connected/studioLinked, app version, platform.
4. Tool policy: approval, khi nào dùng tool nào; tool schemas từ registry.
5. Runtime context: model, project name, session title, goal nếu có.
6. Skills đang active (phase 4).
7. User instructions/steering.

- Không hardcode số lượng tool hay danh sách tool.
- Tool schemas lấy từ `ToolRegistry.schemas()`.
- `lint_luau` chỉ được mô tả là basic linter, không hứa "professional".
- Model selection được snapshot vào `turn/start`; retry dùng lại snapshot.
- Title generation là service riêng, dùng model cấu hình `titleModel` (mặc định auto), fallback heuristic 4–5 từ nếu provider lỗi.

### 4.8 Compaction

- Token estimate: dùng usage từ provider khi có; nếu chưa, xấp xỉ `chars / 4`.
- Ngưỡng: 70% prune, 85% summarize.
- Prune: thay tool result cũ hơn 2 turn bằng `[tool result omitted: N chars]`.
- Summarize: tóm tắt các turn cũ hơn 6 turn gần nhất; ghi `compaction/summary`; summary được chèn vào derived history.
- Summarizer dùng `titleModel` hoặc model hiện tại với max output 1024; lỗi → deterministic truncation.
- Prune chỉ áp dụng khi build request gửi model, không sửa event log.
- Summarize ghi event mới `compaction/summary`; event gốc không bị UPDATE/DELETE.

### 4.9 Provider layer

- `StreamEvent` chuẩn hoá: `text_delta`, `reasoning_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `usage`, `finish`, `error`.
- Adapter native: OpenAI, Gemini, OpenRouter, ProxyPal.
- Generic OpenAI-compatible connector:
  - User nhập `baseUrl`, `apiKey`.
  - Model list lấy từ `${baseUrl}/models`.
  - Provider ID `custom:<slug>`.
- Danh sách model trong composer chỉ gồm provider đã cấu hình và model fetch thành công; provider chưa cấu hình chỉ hiện trong Settings với trạng thái `Chưa cấu hình`.
- `auto` resolve:
  1. Model người dùng đã chọn gần nhất nếu còn khả dụng.
  2. Provider ưu tiên: Google → OpenAI → OpenRouter → ProxyPal → custom.
  3. Model đầu tiên có tool calling và context lớn nhất trong provider đó.
  4. Không có provider nào → error event `NO_PROVIDER` kèm CTA mở Settings.
- Cấu hình nâng cao (`titleModel`, compaction thresholds, auto priority) đọc từ `settings.json` trong `%APPDATA%/MorphiIntelligence` và env khi boot; 1.1.0 không có endpoint ghi, UI Advanced chỉ hiển thị.
- Token usage ghi vào `assistant/message.usage` và hiển thị nhỏ ở footer.

### 4.10 Plugin registry & advanced harness

```ts
interface HarnessPlugin {
  id: string;
  version: string;
  setup(ctx: HarnessContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

interface HarnessContext {
  events: EventStore;
  sessions: SessionStore;
  tools: ToolRegistry;
  llm: LlmRegistry;
  approval: ApprovalService;
  compaction: CompactionService;
  subagents: SubagentRuntime;
  skills: SkillLoader;
  goals: GoalService;
  workflows: WorkflowEngine;
  logger: Logger;
}
```

- Plugin load theo thứ tự cố định trong `server/src/harness/plugins/index.ts`.
- Không load plugin bên ngoài trong 1.1.0.
- `dispose` unwind đăng ký khi shutdown.
- **Subagents:** max depth 2, max 3 concurrent; child session riêng; tool subset; parent nhận summary; UI card tiến độ.
- **Skills:** file Markdown có frontmatter (`name`, `description`, `triggers`), load từ bundle và `%APPDATA%/MorphiIntelligence/skills`; kích hoạt bằng trigger hoặc lệnh `/skill`; chèn section vào prompt; trạng thái active ghi bằng event `session/skills`. Built-in 1.1.0: `roblox-luau-style`, `roblox-debug`.
- **Goals:** một goal active/session; trạng thái `active`/`done`/`blocked`; agent tiếp tục turn cho đến khi done/blocked hoặc tối đa 12 turn; UI goal bar.
- **Workflows:** built-in `roblox-feature` và `roblox-debug`, mỗi workflow gồm các phase cố định; phase có prompt/tool subset; phát `workflow/*` events; UI timeline.

### 4.11 Roblox Studio MCP (chính thức)

1.1.0 chỉ tích hợp **MCP server chính thức của Roblox**. Không dùng, không pin, không bundle package bên thứ ba (`robloxstudio-mcp` của `boshyxd`), và không spawn bằng `npx`/`ELECTRON_RUN_AS_NODE`.

Hai hình thái chính thức, đều transport `stdio`:

| Hình thái | Windows | macOS |
|---|---|---|
| Built-in trong Roblox Studio (khuyến nghị; bật qua **Assistant › Manage MCP Servers**, không cần cài plugin) | `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` | `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` |
| Binary tham chiếu chính thức `Roblox/studio-rust-mcp-server` | `rbx-studio-mcp.exe --stdio` | `macOS-rbx-studio-mcp.zip` → `--stdio` |

- `resolveOfficialMcpServer(overrides, env)` trả `{ command, args, source, path }` theo chuỗi resolve **đã đo thật
  trên máy ngày 2026-11-03** (xem Ruling M3 trong plan): (1) đường dẫn người dùng nhập ở Settings › MCP, đã validate;
  (2) `%LOCALAPPDATA%\Roblox\mcp.bat`; (3) `%LOCALAPPDATA%\Roblox\Versions\version-*\StudioMCP.exe` (mtime cao nhất);
  (4) fallback registry `HKCU\Software\Roblox\RobloxStudio\ContentFolder` → `<ContentFolder>\..\StudioMCP.exe`
  (đây chính là fallback `mcp.bat` dùng); (5) binary `rbx-studio-mcp` chính thức; (6) `null`.
  Lý do phải có (3)–(4): `mcp.bat` **hardcode** thư mục version hiện tại (`version-<hash>`) nên nó vỡ khi Studio
  OTA-update; nội dung `.bat` là dữ liệu, không bao giờ được nối thành command string.
- `source` (`"settings" | "studio-builtin" | "studio-binary" | "none"`) hiển thị ở MCP tab và `GET /api/mcp/status`
  để người dùng biết đang chạy hình thái nào; kèm `path` đã resolve và `version` đọc từ `serverInfo` của `initialize`.
- Server con spawn bằng `child_process.spawn` với stdio pipe; log stderr qua `redact`; không ghi đường dẫn tuyệt đối
  vào event payload, chỉ ghi `source`. **Thư mục `%LOCALAPPDATA%\Roblox\StudioMCP\` chứa `auth.token` của Studio:
  nghiêm cấm đọc, ghi log, copy hoặc đưa vào payload chuẩn đoán** (đã xác nhận tồn tại khi đo; Morphi không cần nó).
- **Hợp đồng đo thật của server (thay cho danh sách tool từng đoán trong bản trước):** `serverInfo`
  `{name:"RobloxStudio", version:"1.0.0"}`, `protocolVersion 2024-11-05`, capabilities `{tools:{listChanged:true}}`,
  `resources: []`, `prompts: []`, instructions `Studio MCP Proxy - bridges MCP clients with Roblox Studio`.
  **34 tool**, `studio_id` bắt buộc trên **33/34** (chỉ `list_roblox_studios` không cần). Danh sách thật:
  `list_roblox_studios`, `get_studio_state`, `get_console_output`, `start_stop_play`, `execute_luau`, `multi_edit`,
  `script_read`, `script_search`, `script_grep`, `search_game_tree`, `inspect_instance`, `insert_asset`,
  `search_asset`, `upload_image`, `store_image`, `screen_capture`, `http_get`, `character_navigation`,
  `user_mouse_input`, `user_keyboard_input`, `auto_setup_avatar`, `generate_scene`, `generate_mesh`,
  `generate_procedural_model`, `generate_texture`, `generate_material`, `generate_avatar`, `segment_mesh`,
  `wait_job_finished`, `skill`, `list_skills`, `create_skill`, `edit_skill`, `subagent`.
  Các tên `run_code`, `get_studio_mode`, `insert_model`, `run_script_in_play_mode` **không tồn tại** — bản spec trước
  ghi sai do chưa đo.
- **Tên tool publish trong Morphi là `studio.<toolName>`**, không giữ nguyên, vì server thật có `skill`,
  `subagent`, `create_skill`, `edit_skill`, `list_skills`, `http_get` sẽ **đụng** built-in của §4.7 (skills) và
  §4.10 (subagents); registry keyed-by-name sẽ ghi đè ngầm. `presentation.label` và approval vẫn hiển thị nhãn tiếng Việt.
- **Không phân loại rủi ro theo tiền tố tên tool.** Đo thật cho thấy `execute_luau` thực thi Luau tùy ý trên main
  thread của Studio trong khi `get_console_output` chỉ đọc log, nên tiền tố `get_`/`list_`/`read_` không phải tín hiệu
  an toàn. Nhóm đọc (`list_roblox_studios`, `get_studio_state`, `get_console_output`, `inspect_instance`,
  `search_game_tree`, `script_read`, `script_search`, `script_grep`, `search_asset`, `skill`, `list_skills`,
  `http_get`) → `auto`; nhóm biến đổi place (`multi_edit`, `execute_luau`, `insert_asset`, `start_stop_play`,
  `character_navigation`, `user_mouse_input`, `user_keyboard_input`, `auto_setup_avatar`) → `ask`; nhóm công bố/bupload
  hoặc tốn tài nguyên (`upload_image`, `store_image`, `generate_*`, `segment_mesh`, `create_skill`, `edit_skill`) → `ask`.
  Một contract test assert ánh xạ 1:1 với `tools/list` để tool mới từ upstream **fail test**, không rơi về `auto`.
- `studio_id` do **Morphi inject**, không bắt model đoán: schema quảng cáo cho LLM bỏ `studio_id` khỏi `required`,
  gateway bơm id đã resolve ngay trước `callTool`. Bỏ qua `studio_id` vẫn chạy khi chỉ có một Studio;
  `studio_id: ""` fail với `-32603 "Client proxy is out of date, restart to update"`.
- Vì `listChanged: true`, Morphi phải subscribe `notifications/tools/list_changed` và gọi `syncTools()`; ảnh snapshot
  một lần lúc boot là defect. Tool output có thể rất lớn (`tools/list` đã 72,637 ký tự; `search_asset` schema 7,411)
  nên khi cắt theo `MAX_TOOL_OUTPUT_CHARS` phải **ghi marker kèm độ dài gốc**, không cắt im lặng.
  `screen_capture` trả **image content block**, pipeline phải giữ ảnh chứ không flatten thành text.
- Nhóm `generate_*`/`segment_mesh`/`auto_setup_avatar` hỗ trợ `async` và hoàn tất qua `wait_job_finished(jobId,…)`;
  timeout each tool phải theo `ToolDefinition.timeoutMs` chứ không dùng một giá trị cứng cho mọi call.
- `studioLinked` nghĩa là server MCP báo có một instance Roblox Studio đang chạy; không có Studio → UI hiện chip
  “Mất kết nối” kèm hướng dẫn bật trong Studio, app vẫn chạy bình thường.
- Không phát hiện được server nào → `connected: false`, `source: null`, thông báo tiếng Việt chỉ rõ cách bật; không fallback sang package bên thứ ba.

---

## 5. HTTP API

Tất cả API (trừ `/api/health`) yêu cầu `X-Morphi-Token`. UI gọi relative `/api`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/health` | Trạng thái server, version, port |
| GET | `/api/projects` | Danh sách project |
| POST | `/api/projects` | Tạo project |
| DELETE | `/api/projects/:id` | Xoá project + sessions |
| GET | `/api/sessions?projectId=` | Session summaries, không kèm messages |
| POST | `/api/sessions` | Tạo session |
| GET | `/api/sessions/:id` | Session + derived messages/steps |
| GET | `/api/sessions/:id/events?after=` | Replay event |
| DELETE | `/api/sessions/:id` | Xoá session |
| POST | `/api/sessions/:id/pin` | Pin/unpin |
| POST | `/api/chat/stream` | SSE chat; body `{ sessionId, message, model, thinking }` |
| POST | `/api/chat/cancel` | Huỷ turn đang chạy |
| POST | `/api/chat/regenerate` | Regenerate assistant message |
| POST | `/api/approvals/:id` | `{ decision: 'allow' \| 'deny', scope: 'once' \| 'session' }` |
| GET | `/api/providers` | Provider + trạng thái cấu hình |
| PUT | `/api/providers/:id/config` | Lưu `baseUrl`, `enabled` (không nhận key) |
| GET | `/api/models?usable=true` | Model khả dụng |
| GET | `/api/tools` | Tool metadata (không lộ execute) |
| POST | `/api/sessions/:id/tools/:name` | Bật/tắt tool theo session, body `{ enabled }` |
| GET | `/api/skills` | Danh sách skill built-in + user |
| POST | `/api/sessions/:id/skills/:name` | Bật/tắt skill theo session, body `{ enabled }` |
| POST | `/api/sessions/:id/goal` | Đặt goal, body `{ objective }` |
| DELETE | `/api/sessions/:id/goal` | Xoá goal của session |
| GET | `/api/workflows` | Danh sách workflow built-in |
| POST | `/api/sessions/:id/workflows` | Chạy workflow, body `{ name }` |
| GET | `/api/mcp/status` | `{ connected, studioLinked }` |
| POST | `/api/mcp/reconnect` | Reconnect MCP |
| GET | `/api/memory/stats` | Thống kê DB |
| DELETE | `/api/memory` | Xoá toàn bộ dữ liệu |

**IPC credentials (renderer ↔ Electron main, không qua HTTP):**

- `morphi:credentials:set` `{ providerId, apiKey }`
- `morphi:credentials:delete` `{ providerId }`
- `morphi:credentials:status` → `{ providerId, configured }[]`
- `morphi:token` → token hiện tại cho renderer
- Main forward key đã giải mã cho server qua `parentPort`; server không bao giờ trả key ra HTTP.

SSE envelope:

```json
{
  "id": "evt_...",
  "seq": 42,
  "type": "assistant/delta",
  "payload": { "turnId": "turn_...", "text": "..." },
  "ts": 1760000000000
}
```

- `seq` chỉ có với durable event; live event dùng `id` riêng.
- Kết thúc stream luôn có `turn/end`.
- Lỗi trước khi stream bắt đầu trả HTTP 4xx JSON; lỗi giữa stream trả event `error` + `turn/end`.

---

## 6. UI design

### 6.1 Layout

```
┌──────┬─────────────────────────────┬──────────────────────────────┐
│ rail │ sidebar 260px               │ main                         │
│ 56px │                             │ header + chat + composer     │
└──────┴─────────────────────────────┴──────────────────────────────┘
```

- **Rail:** Chat, Dự án, Bộ nhớ, Studio (MCP status), Cài đặt.
- **Sidebar:**
  - Logo Morphi + nút collapse.
  - Nút **Cuộc trò chuyện mới**.
  - Nút **Tìm kiếm** mở palette (Ctrl/Cmd+K).
  - **Dự án** (collapsible; chọn project lọc recents).
  - **Gần đây**: nhóm Hôm nay / Hôm qua / 7 ngày qua / Cũ hơn; mỗi item hiện title + project name; hover có pin/delete.
  - Footer: version, trạng thái kết nối.
- Sidebar collapse xuống rail; trạng thái lưu localStorage.
- Dưới 1024px sidebar thành overlay; dưới 768px composer full width.
- Không có tab Chat/Work, không usage card, không badge “Free offer”.

### 6.2 Header

- Trái: nút toggle sidebar + breadcrumb `Dự án › Phiên`.
- Giữa: không tab; hiển thị trạng thái agent (`Đang nghĩ`, `Đang chạy tool`, `Sẵn sàng`).
- Phải: MCP status chip (Bridge Active / Đang kết nối / Mất kết nối), theme toggle.

### 6.3 Welcome & composer

- Heading: “Hôm nay bạn muốn xây gì?”
- Composer:
  - Textarea tự giãn, placeholder “Hỏi Morphi bất cứ điều gì…”.
  - Nút `+` mở panel **Công cụ** (bật/tắt tool, hiện tool count).
  - Model picker **Tự động** / model cụ thể.
  - Toggle **Suy nghĩ sâu** (extended thinking).
  - Send/Stop.
- 4 suggestion rows: *Tạo hệ thống combat*, *Thiết kế DataStore*, *Debug placement*, *Tạo cutscene*.
- Không thêm mic/attachment/usage giả.

### 6.4 Chat rendering

- User: bubble xám nhạt bên phải.
- Assistant: full-width, avatar “M”, markdown, code block copy.
- Thinking block “Đã suy nghĩ trong Xs”, collapsed mặc định, text stream khi đang chạy.
- Tool call card: icon, label tiếng Việt, status `Đang chạy / Hoàn tất / Lỗi / Đã huỷ`, expand args/result.
- Text/tool xen kẽ theo `deriveSteps`.
- Footer: copy, regenerate, token usage.
- Inline error card với mã lỗi, message thân thiện, nút Thử lại.
- Approval modal: tool name, args JSON, risk badge, text cảnh báo, nút Cho phép một lần / Cho phép trong phiên / Từ chối.
- Plan panel (todo list từ `todo_write`), Subagent card, Goal bar (phase 4).

### 6.5 Settings

- Layout ChatGPT: nav trái (Chung, Nhà cung cấp, MCP, Bộ nhớ, Nâng cao), panel phải.
- Provider card: logo, trạng thái `Đã cấu hình / Chưa cấu hình / Lỗi`, input key (masked), base URL cho custom connector, nút Lưu/Xoá. Key gửi qua IPC `morphi:credentials:set`/`delete`; base URL qua `PUT /api/providers/:id/config`.
- Không hiển thị key đã lưu; chỉ hiện `••••••••` + trạng thái; key không bao giờ đi qua HTTP.
- MCP tab: trạng thái, nguồn server (`studio-builtin` / `studio-binary` / `settings`), đường dẫn thực thi, version, nút reconnect, log gần nhất, và hướng dẫn bật MCP trong Roblox Studio (Assistant › Manage MCP Servers) khi chưa kết nối.
- Memory tab: stats, clear data với ConfirmModal.
- Advanced: model auto priority, title model, compaction thresholds (read-only trong 1.1.0).

### 6.6 Design system

- Palette: nền `#ffffff`/`#f9f9f9`, sidebar `#f9f9f9`, border `#ececec`, text `#0d0d0d`/`#5d5d5d`, CTA đen, accent emerald `#10a37f`.
- Dark: `#212121` main, `#171717` sidebar, `#2f2f2f` card, border `#383838`.
- Typography: Inter/system; body 15px, sidebar 13px, heading welcome 32px, code 13px.
- Radius: 8/12/16/24px; shadow nhẹ; bỏ glassmorphism nặng.
- Motion 150–200ms; tôn trọng `prefers-reduced-motion`.
- Focus ring 2px accent; contrast AA.
- Scrollbar mảnh, hover-only ở sidebar.

#### 6.6.1 Tương phản chữ (bắt buộc)

Người dùng phản ánh “chữ có màu khó nhìn”, nên các quy định sau là ràng buộc, không phải gợi ý:

- Text thật sự nhìn thấy được phải đạt **≥ 4.5:1** với nền (≥ 3:1 chỉ chấp nhận cho chữ ≥ 24px hoặc icon); check cả light lẫn dark.
- **Cấm modifier opacity trên text** (`text-*/20`, `/30`, `/40`, `/50`, `/60`, `opacity-*` trên nhãn). Muốn nhạt hơn thì dùng token màu riêng, không dùng opacity.
- Mỗi mode khai báo đủ 3 mức text: `--color-text-primary`, `--color-text-secondary` (nhãn phụ, ≥ 4.5:1), `--color-text-tertiary` (meta, footnote, vẫn ≥ 4.5:1). Không có mức “mờ trang trí”.
- `placeholder` dùng `--color-text-tertiary`, không under-token.
- Brand `#10a37f` **không** dùng làm màu chữ nhỏ trên nền trắng (chỉ 3.17:1). Chữ accent dùng `--color-brand-text` (`#0b7d61` light / `#34d399` dark, ≥ 4.5:1); nền accent + chữ trắng chỉ dùng cho control ≥ 16px và đạt 4.5:1.
- Trạng thái (thành công/cảnh báo/lỗi) dùng token `--color-{success,warning,danger}-text` per mode (light `*-700`, dark `*-400`) trên nền tint `*-500/10`; cấm `text-green-500`/`amber-400`/`red-300` hardcode trên nền pastel.
- Hiệu ứng shimmer/gradient text chỉ được dùng khi `currentColor` vẫn đạt tương phản ở cả hai mode; không gradient trắng trên nền trắng.
- Không dưới 11px cho text thật; icon-only thì phải có tooltip/aria-label.
- Inline code trong `.prose`: không `opacity`; dùng `--color-text-primary` trên nền `--color-bg-inset`.

#### 6.6.2 Không “vibe-coded”

- Một palette duy nhất: trung tính (nền/border/text) + 1 accent + 4 token trạng thái. Không cầu vồng, không gradient trang trí, không glassmorphism, không shadow tím/xanh.
- Một thang radius (8/12/16/24) và một thang spacing (4/8/12/16/24); mọi giá trị lẻ (`text-[13px]`, `p-[7px]`) phải được đổi thành token.
- Khoảng cách, alignment và cỡ chữ đồng nhất giữa các panel; không bo góc lệch giữa button và container chứa nó.
- Icon cùng một bộ (lucide), cùng strokeWidth; không trộn emoji làm icon chức năng.
- Không số liệu/label giả, không “Coming soon”, không nút đi vào chỗ chết; tính năng chưa có thì ẩn hẳn.
- Copy tiếng Việt tự nhiên, cộc lốc kiểu UI thật; không Title Case máy móc, không dấu thăng hoa kiểu marketing.

### 6.7 i18n & accessibility

- Chuỗi UI tập trung tại `client/src/i18n/vi.ts`; không hardcode tiếng Anh trong component.
- Giữ nguyên tên model/provider/tool gốc khi là danh từ kỹ thuật.
- Keyboard: Ctrl/Cmd+K search, Ctrl/Cmd+N new chat, Esc close modal, Enter send, Shift+Enter newline.
- ARIA labels cho icon buttons; modal focus trap; live region cho trạng thái agent.

### 6.8 Component mapping

| Mới / đổi tên | Nguồn hiện tại |
|---|---|
| `AppShell`, `Rail`, `Sidebar`, `SearchPalette` | `Sidebar.tsx`, `ChatInterface.tsx` |
| `ChatView`, `WelcomeView`, `Composer`, `ModelPicker` | `ChatInterface.tsx`, `InputArea.tsx` |
| `MessageItem`, `ThinkingBlock`, `ToolCallCard`, `ApprovalModal` | `Message.tsx` |
| `SettingsModal` layout mới | `SettingsModal.tsx` |
| `PlanPanel`, `SubagentCard`, `GoalBar` | mới (phase 4) |
| Xoá | `App.css`, `NotesManager.tsx`, `StepIndicator.tsx`, asset Vite thừa |

---

## 7. Bug fixes

| # | Bug | Fix |
|---|---|---|
| 1 | SSE error bị nuốt | Parser tách transport/event error; gọi `onError` một lần |
| 2 | Tin nhắn đầu tiên fail | Dùng `projectId` local sau createProject |
| 3 | Stop không dừng agent | AbortSignal end-to-end; cancel endpoint; `turn/end cancelled` |
| 4 | Regenerate trùng message | Regenerate event tham chiếu user message cũ; projection ẩn output cũ |
| 5 | thought/steps không hiện | Render từ projection/event |
| 6 | Connector giả | Generic OpenAI-compatible provider; ẩn provider chưa hỗ trợ |
| 7 | Key mất sau restart | safeStorage + nạp lại khi boot |
| 8 | Model 1.5 hardcode | Auto model + title model configurable |
| 9 | Tool result rỗng | Dùng `result !== undefined` |
| 10 | Session N+1 | Summary API; full history chỉ khi mở session |
| 11 | Server crash giết app | utilityProcess + restart policy |
| 12 | Hardcode localhost | Relative `/api`, port động, token |

---

## 8. Security & robustness

- Bind `127.0.0.1`; không mở LAN.
- CORS same-origin; kiểm tra `Origin`/`Host`; từ chối request ngoài loopback.
- Token ngẫu nhiên mỗi launch; header `X-Morphi-Token`; SSE dùng fetch header.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'`.
- Approval cho tool nguy hiểm; mặc định deny; audit event.
- safeStorage cho key; log redaction; không log args nhạy cảm.
- Chỉ kết nối MCP server chính thức của Roblox (§4.11): built-in Studio hoặc binary `rbx-studio-mcp`; đường dẫn resolution luôn validate bằng allowlist (khớp prefix `%LOCALAPPDATA%\Roblox\`, `/Applications/RobloxStudio.app/`, hoặc chính xác là `cmd.exe`) trước khi spawn; không nhận chuỗi lệnh tự do từ renderer.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` nếu tương thích; chặn `will-navigate`, mở link ngoài qua shell với allowlist.
- Single-instance lock; health check timeout 15s; dialog lỗi thay vì cửa sổ trắng.
- Validate input bằng zod; body limit 2MB (không cần 50MB).
- Redact token/key khỏi log.

---

## 9. Cleanup

- Đã xoá `Morphi.exe`, `build_log.txt`, `build_log_final.txt`.
- Xoá `server/src/test-fetch.ts/js`, `client/src/App.css`, asset Vite thừa, `NotesManager.tsx`, `StepIndicator.tsx` nếu không dùng.
- Xoá tính năng Notes khỏi backend (`MemoryService` notes methods, route/API nếu có); schema mới không có bảng notes.
- Bỏ migration `memory.json`, code legacy `calls`, `create_task` giả (thay bằng `todo_write`).
- Đồng bộ version `1.1.0` root/client/server; thêm `engines`, `packageManager`.
- Thêm `LICENSE` (ISC), `.env.example`, `.editorconfig`.
- `.gitignore` thêm `build_log*`, DB/WAL, test artifacts.
- README mới: kiến trúc, setup, security, troubleshooting MCP, dev/test commands.
- CI GitHub Actions: install → lint → test → build (Windows + Ubuntu).
- Đổi title “Morphi Studio” → “Morphi Intelligence”; favicon logo.
- Không commit `dist/`, `dist_electron/`, DB.

---

## 10. Testing

### 10.1 Unit (Vitest)

- Event store: append seq, duplicate seq, transaction rollback.
- Projection: deriveMessages với user/assistant/tool/attempt/compaction; regenerate supersede.
- Tool pipeline: approval allow/deny/expire, cancel, timeout, concurrency barrier, truncation.
- Agent loop: retry 429, no retry 400, cancel mid-stream, cancel mid-tool, max steps.
- Compaction: threshold, prune, summarize fallback.
- Provider normalization: OpenAI/Gemini/OpenRouter stream → StreamEvent.
- Auto model resolution.
- Goals/workflows/subagents: giới hạn turn/depth/concurrency, phase events.

### 10.2 Integration

- SSE route với fake LLM + MCP stub: content, tool call, approval, cancel, error.
- Auth: thiếu/sai token → 401; origin lạ → 403.
- Credential IPC: set/delete/status; key không xuất hiện trong HTTP response/log.
- Provider config: `PUT /api/providers/:id/config` chỉ nhận baseUrl/enabled; key chỉ qua IPC.
- Session replay: reload cho ra cùng messages/steps.
- Regenerate: không nhân đôi user message.

### 10.3 E2E (Playwright)

- Fresh DB → gửi tin đầu tiên thành công.
- Missing API key → inline error + CTA Settings.
- Tool call + approval allow/deny.
- Stop giữa tool → UI “Đã dừng”, không còn tool chạy.
- Reload session → history/thinking/tool steps đúng.
- Search palette, new chat, theme, responsive.

### 10.4 Manual

- `npm run build`, `npm test`, `npm run e2e`, `npm run dist`.
- Chạy portable trên Windows sạch, không cài Node; xác nhận app tự phát hiện và kết nối MCP Studio chính thức khi Studio đang bật.
- Kiểm tra không còn key plaintext, không còn localhost hardcode, không còn file rác.

---

## 11. Phases & deliverables

### Phase 1 — Stabilize

- Fix #1–#12.
- Bind loopback, token, CSP, safeStorage.
- utilityProcess server, relative API, single-instance.
- Xoá file rác, thêm Vitest + CI skeleton.
- **Deliverable:** bản chạy ổn định, test nền tảng pass.

### Phase 2 — Core harness

- Event store + projections + schema mới.
- Tool registry/pipeline/approval.
- Agent loop cancel/retry/limits.
- Prompt assembly, compaction, provider seam + generic connector.
- API mới + SSE event envelope.
- **Deliverable:** chat hoạt động hoàn toàn trên harness mới, replay được.

### Phase 3 — UI ChatGPT desktop

- AppShell/Rail/Sidebar/SearchPalette.
- Welcome/Composer/ModelPicker.
- Chat rendering mới, Thinking/Tool/Approval.
- Settings layout mới, Memory/Onboarding restyle.
- i18n tiếng Việt, theme, responsive, accessibility.
- **Deliverable:** UI đạt design, E2E pass.

### Phase 4 — Advanced harness

- Plugin registry.
- Subagents, skills, goals, workflows + UI surfaces.
- **Deliverable:** demo subagent/skill/goal/workflow hoạt động, event log ghi đầy đủ.

### Phase 5 — Hardening & release

- Test coverage đầy đủ, CI xanh.
- Đóng gói portable, kiểm tra trên máy sạch.
- README/LICENSE/docs, version 1.1.0.
- **Deliverable:** bản release 1.1.0.

---

## 12. Acceptance criteria

1. `npm run build`, `npm test` pass trên Windows và Ubuntu CI; `npm run e2e` pass trên Windows.
2. DB trống → gửi tin đầu tiên thành công, không cần reload.
3. Missing/invalid API key hiển thị lỗi inline + CTA; không có message rỗng.
4. Stop dừng provider stream và tool trong tối đa 2 giây; event `turn/end cancelled`.
5. Regenerate không tạo user message trùng trong DB/projection.
6. Reload session khôi phục đúng nội dung, thinking, tool steps, approval decisions.
7. Không còn key plaintext; API từ chối request thiếu token/origin sai.
8. Không còn `http://localhost:3000` hardcode; UI gọi relative `/api`.
9. Model picker chỉ hiển thị model dùng được; provider chưa cấu hình hiện CTA trong Settings.
10. App chạy được không cần Node cài sẵn và không còn dependency MCP bên thứ ba; MCP Studio chính thức được phát hiện theo §4.11, reconnect hoạt động, và khi chưa bật Studio thì UI hiển thị hướng dẫn rõ ràng.
11. UI đạt layout ChatGPT desktop đã chốt, tiếng Việt, light/dark, không lỗi console; mọi text đạt ≥ 4.5:1 ở cả hai mode theo §6.6.1, không còn opacity trên text và không còn màu trạng thái hardcode.
12. Không còn file rác/dead code đã liệt kê; LICENSE, `.env.example`, README, CI đầy đủ.
13. Version root/client/server = `1.1.0`.
14. Portable build khởi động, chat, tool call, approval, stop, reload đều hoạt động.
15. Subagent, skill, goal, workflow chạy được từ UI; event tương ứng replay đúng.

---

## 13. Risks & mitigations

| Rủi ro | Giảm thiểu |
|---|---|
| Harness full quá lớn, dễ trễ | Phase hóa; mỗi phase shippable; test trước khi chuyển phase |
| Event-sourced refactor gây regression UI | Fake LLM + replay tests; giữ API contract rõ |
| MCP package thay đổi/hỏng | Dùng server chính thức của Roblox; resolve nhiều nguồn + `source` trong status; MCP stub test; reconnect + log; không pin package bên thứ ba |
| Electron safeStorage không khả dụng | Fallback session-only; hiển thị cảnh báo, không ghi plaintext |
| Approval làm chậm workflow | `ask-once` theo phiên; tool đọc auto |
| Subagent/workflow tốn token | Giới hạn depth/concurrency/steps; hiển thị usage |
| UI rewrite mất tính năng | Component mapping + E2E checklist |
| Packaging native module lỗi | CI build + kiểm tra trên máy sạch |

---

## 14. Definition of done

- Tất cả acceptance criteria đạt.
- Không còn bug P0/P1 đã liệt kê.
- Event replay cho ra history giống hệt.
- Security checklist pass.
- Repo sạch, CI xanh, docs đầy đủ.
- Release 1.1.0 đóng gói và kiểm tra thực tế trên Windows.
