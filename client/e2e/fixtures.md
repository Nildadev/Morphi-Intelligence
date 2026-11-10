# E2E fixtures — Task 25

Mọi dữ liệu trong suite này là **giả có chủ đích**, không phải production data. Không có API key thật,
không có kết nối mạng tới provider, không có Roblox Studio.

## Cách bật

`MORPHI_FAKE_LLM=1` tại composition root `server/src/index.ts` (R25-2). Config Playwright đặt sẵn biến
này cho `webServer` của server. Chạy: `npm run e2e` (từ `client/`) hoặc `npm run e2e` (từ root).

## Adapter

`server/src/harness/llm/fake.ts` — `createFakeAdapter()` phát `StreamEvent` thật theo đúng vocabulary mà
`AgentLoop.streamAttempt` tiêu thụ (`loop.ts:380-415`). Hai model:

| id | supportsTools | dùng cho |
|---|---|---|
| `fake-tools` | true | `resolveAuto()` — có tool, có approval |
| `fake-text` | false | danh sách model, title service |

Credential giả `fake-e2e-credential` được seed để `getModels()` / `resolveAuto()` chạy được mà không đụng
`safeStorage`. `fake` đứng đầu `autoPriority`.

## Script

Chọn bằng marker ở ĐẦU tin nhắn: `/script <name>`. Không có marker ⇒ `MORPHI_FAKE_SCRIPT` (mặc định `text`).
Một server phục vụ mọi scenario.

| script | phát ra | scenario |
|---|---|---|
| `text` | 3 `text_delta` + `usage` + `finish(stop)` | 1, 6, 7, 8, 9, 10, 12 |
| `tool-then-text` | lượt 1: `tool_call_start/delta/end` cho `e2e_echo` + `finish(tool_calls)`; lượt 2 (có `role:tool`): text + `finish(stop)` | 3, 4 |
| `missing-key` | `error { code: 'NO_PROVIDER', retryable: false }` + `finish(error)` | 2 |
| `slow` | 14 delta, 180 ms/chunk | 5, 12 |
| `cancel` | giống `slow` | 5 |
| `regenerate` | 2 delta, nội dung khác | 6 |

Fake adapter `await` có `AbortSignal`, nên nút **Dừng tạo** đi đúng đường cooperative cancel thật.

## Tool approval

`e2e_echo` được đăng ký **chỉ trong fake mode** với `approval: 'ask'`. Hai built-in còn lại
(`todo_write`, `lint_luau`) là `approval: 'auto'`, nên đây là cách duy nhất để E2E lái
`ApprovalModal` thật (Cho phép / Từ chối) qua `POST /api/approvals/:id` mà không cần Studio MCP.

## Database & isolation

`MORPHI_DB_PATH=./.tmp/e2e.db` (tương đối `server/`). Mỗi test gọi `DELETE /api/memory` rồi
`page.goto('/')` — xoá projects/sessions/events nhưng giữ `provider_settings`. Không có test nào ghi
vào DB thật của người dùng. `reuseExistingServer` chỉ bật khi không phải CI; Playwright tự tắt server
khi kết thúc, không giết process ngoài (R25-7).

## Token

`/api/health` không cần token; mọi API khác cần `X-Morphi-Token: dev-token`. Client Vite DEV tự rơi về
`dev-token` (`lib/token.ts`) vì không có bridge Electron.

## Node ABI (R25-8)

`better_sqlite3.node` biên dịch cho NODE_MODULE_VERSION **147**. Server `webServer` gọi thẳng
`C:\Program Files\nodejs\node.exe` (v26.12.0). Vite không có native dependency nên chạy bằng Node
ambient. Chạy server bằng Node 22 cho 113 false failure.
