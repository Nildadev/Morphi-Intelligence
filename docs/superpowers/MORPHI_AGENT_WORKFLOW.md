# Quy ước làm việc của agent BÊN TRONG Morphi

> Áp dụng cho **Morphi AI** — agent chạy trong app, trợ giúp người dùng xây Roblox experience.
> KHÔNG phải quy ước cho agent đang lập trình repo này (WorkBuddy/Qoder đã có superpowers riêng).

**Nguồn:** [obra/superpowers](https://github.com/obra/superpowers) — *"An agentic skills framework &
software development methodology"*. Các nguyên tắc trích/ghép: *"Mandatory workflows, not
suggestions"*, *"Evidence over claims — Verify before declaring success"*, *"Systematic over ad-hoc —
Process over guessing"*, RED-GREEN TDD, YAGNI/DRY, spec → plan → review → verify.

**Mục tiêu:** agent trong Morphi không "vibe code" — không phăng ra Luau nghe có lý, không bịa
đường dẫn/số liệu/trạng thái Studio, không tuyên bố xong khi chưa có bằng chứng.

---

## 1. Cái gì thay đổi trong hành vi của agent

| Trước | Sau |
|---|---|
| System prompt chỉ có Identity + Safety + tool policy | Thêm **`## Working agreement`** — luôn bật, mọi turn, kể cả khi không có tool |
| Không có khái niệm skill | 6 skill built-in, tự kích hoạt theo trigger hoặc bật theo phiên |
| Agent có thể nhảy thẳng vào code | Phải chốt intent/spec → plan nhỏ → test đỏ → code tối thiểu → review → verify |
| "Xong rồi" chỉ là câu chữ | Mọi claim phải kèm kết quả đo được trong chính turn đó |
| Không có cách bật/tắt quy tắc | `GET /api/skills`, `POST /api/sessions/:id/skills/:name` |

Luật nằm ở `server/src/harness/prompt/sections.ts::workingAgreement()`, được đưa vào
`assembleSystemPrompt()` **sau Safety, trước Environment**. `assemble.test.ts` pin thứ tự section và
nội dung, nên một lần xoá luật là đỏ ngay.

## 2. Sáu skill built-in

File: `server/src/harness/skills/builtin/*.md` (Markdown, frontmatter `name` / `description` /
`triggers`). 1.1.0 **chỉ có built-in** — không thư mục user, không npm plugin, không tải mạng
(`global-constraints.md`).

| Skill | superpowers gốc | Nội dung Morphi | Trigger mẫu |
|---|---|---|---|
| `morphi-brainstorm` | `brainstorming` | Hỏi intent, chốt spec ngắn, inspect trạng thái thật, YAGNI | `ý tưởng`, `thiết kế`, `tính năng mới` |
| `morphi-plan` | `writing-plans` | Bước nhỏ, đích chính xác, mỗi bước có phép kiểm chứng, không lệch plan | `/plan`, `kế hoạch` |
| `morphi-tdd` | `test-driven-development` | Assertion đỏ trước, code tối thiểu, xanh lại; xoá code viết trước test | `/tdd`, `viết test`, `kiểm thử` |
| `morphi-verify` | `verification-before-completion` | Cấm "should work"; phải chạy lại và trích kết quả thật | `/verify`, `kiểm chứng`, `xác minh` |
| `morphi-review` | `requesting-code-review` | So với plan, xếp Critical/Important/Minor, Critical chặn | `/review`, `rà soát` |
| `morphi-workflow` | `using-superpowers` + vòng lặp | 7 pha: brainstorm → plan → RED → GREEN → review → verify → report | `/workflow`, `quy trình`, `superpowers` |

`morphi-workflow` là **skill mô tả vòng lặp**, không phải workflow engine chạy nền (xem §5).

## 3. Cơ chế (đo được, không phải lời hứa)

```
server/src/harness/skills/loader.ts      SkillLoader.list/get/active/setActive/matchTriggers/bodiesFor
server/src/harness/prompt/sections.ts    workingAgreement() — luôn bật
server/src/harness/prompt/assemble.ts    đưa section vào system prompt
server/src/harness/agent/loop.ts         AgentPromptContext.message + Turn.message (additive)
server/src/harness/harness.ts            skills: SkillLoader + promptHook mặc định
server/src/routes/skills.ts              GET /api/skills, POST /api/sessions/:id/skills/:name
server/scripts/copy-assets.js            copy 6 file .md vào dist/harness/skills/builtin
```

- `session/skills` là event bền vững đã có sẵn trong `events/types.ts`; `setActive()` append event,
  `active()` đọc event cuối cùng. Bật/tắt sống sau khi reload phiên.
- `promptHook` union **skill bật theo phiên** + **skill khớp trigger của đúng tin nhắn này**, khử
  trùng, giữ thứ tự catalogue, rồi truyền vào `assembleSystemPrompt({ skills: bodies })`. Skill chỉ
  có mặt trong turn đó — không làm phình prompt vĩnh viễn.
- Loader **fail loud**: thiếu thư mục built-in hoặc không đọc được file nào ⇒ throw, không trả about
  "không có skill nào" (§6.6.2 cấm trạng thái giả).
- `GET /api/skills` chỉ trả metadata, **không** trả body (body chỉ đi vào system prompt phía server).

Test bảo vệ: `skills/loader.test.ts` (7), `prompt/assemble.test.ts` (+2), `prompt/wiring.test.ts` (3),
`routes/skills.test.ts` (4). `wiring.test.ts` chứng minh chính system prompt của agent chứa luật và
skill body theo trigger — không phải chỉ test module rời rạc.

## 4. Bảng chống vibe-code: nguyên tắc → điểm thực thi trong Morphi

| Nguyên tắc superpowers | Thực thi ở đâu |
|---|---|
| "doesn't just jump into trying to write code" | `## Working agreement` + `morphi-brainstorm` |
| "shows it to you in chunks" / design sign-off | `morphi-brainstorm` bước 2 |
| "every task has exact file paths, complete code, verification steps" | `morphi-plan` |
| "Write tests first, always" / "Deletes code written before tests" | `morphi-tdd` |
| "Evidence over claims — Verify before declaring success" | `morphi-verify` + luật luôn bật |
| "Systematic over ad-hoc — Process over guessing" | `morphi-workflow` 7 pha + dừng hỏi khi blocker |
| "Critical issues block progress" | `morphi-review` |
| YAGNI / DRY / "Simplicity as primary goal" | luôn bật + `morphi-plan` + `morphi-tdd` |
| "without deviating from the plan" | `morphi-plan`, `morphi-workflow` |
| Không bịa dữ liệu (spec §6.6.2) | luôn bật: cấm bịa path/count/asset id/version/Studio state |

## 5. Lệch có chủ đích so với plan Task 27 / 29 (ghi rõ để round sau không tưởng là sót)

| Plan | Quyết định | Lý do |
|---|---|---|
| Dùng `gray-matter` + user dir `%APPDATA%/.../skills`, duplicate ưu tiên user | Parser frontmatter nhỏ, **chỉ built-in** | `global-constraints.md`: 1.1.0 chỉ dùng built-in plugin/skill/workflow, không tải bên thứ ba; tránh thêm runtime dependency cho 6 file ngắn |
| Append `skillsPlugin` vào `BUILTIN_PLUGINS` | Không thêm plugin | Loader được dựng thẳng trong `createHarness` và đã fail-loud; thêm plugin no-op là YAGNI, lại làm `registry.test.ts:245` phải đổi kỳ vọng `['tools']` |
| `pluginsReady: Promise<void>` | Chưa thêm | Không có plugin setup bất đồng bộ; chưa có thao tác đĩa async cần chờ. Vẫn là nợ nếu Task 28/29 mang setup thật vào |
| `SkillPicker.tsx`, `/skill <name>` trong Composer | Chưa làm | Phạm vi lần này là **hành vi agent**; API đã đủ để UI sau này gọi. Ghi nợ Task 27 Step 4 |
| Workflow engine chạy nền + `WorkflowTimeline` | `morphi-workflow` dạng skill | Event `workflow/*` đã có sẵn nhưng chưa có runner; làm nửa vời sẽ tạo timeline giả. Đúng YAGNI, ghi nợ Task 29 |

## 6. Cách dùng / mở rộng

```bash
# Liệt kê skill (có ?sessionId=... để lấy cờ active)
curl -H 'X-Morphi-Token: dev-token' http://127.0.0.1:3000/api/skills

# Bật skill cho một phiên
curl -X POST -H 'X-Morphi-Token: dev-token' -H 'Content-Type: application/json' \
  -d '{"enabled":true}' http://127.0.0.1:3000/api/sessions/<id>/skills/morphi-tdd

# Hoặc chỉ cần gõ trigger trong tin nhắn: "/plan ...", "viết test ...", "/verify ..."
```

Thêm skill: tạo `.md` trong `server/src/harness/skills/builtin/` với 3 field frontmatter, thêm tên vào
danh sách trong `workingAgreement()` (để agent biết nó tồn tại), chạy `npm --prefix server run build`
để `copy-assets.js` đưa vào `dist`. Mọi skill mới phải có test trigger trong `wiring.test.ts`.

## 7. Kiểm chứng lần này (2026-11-05)

```
server vitest (Node 26 / ABI 147)   31 files / 399 tests, exit 0   (+16 test mới)
server build                        exit 0 · [copy-assets] 6 built-in skill(s)
dist loader                         6 skill load được từ dist/harness/skills/builtin
```

`RED → GREEN` đã chạy thật: `loader.test.ts` + `assemble.test.ts` đỏ (`Cannot find module './loader'`,
thiếu `## Working agreement`) trước khi implement; `skills.test.ts` đỏ 404 trước khi có route.

Các gate còn lại (client 422, E2E 13, tsc, eslint) chạy lại ở cuối phiên — xem `progress.md`.
