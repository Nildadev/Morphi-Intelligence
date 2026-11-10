# UI verification gate — Task 25, Step 5

**Ngày:** 2026-11-05 · **Máy:** Windows, Chromium 1248 (Playwright 1.64.1), viewport 1440×900 / 375×812.
**Lệnh:** `NO_PROXY=127.0.0.1,localhost,::1 npx playwright test --reporter=list` trong `client/`.
**Kết quả:** `13 passed (48.1s)`, exit 0 — log `scratch-review5/e2e-final.log`.
**Screenshot:** `client/test-results/ui-gate/*.png` (7 ảnh, chụp từ browser thật, không phải jsdom).

Gate này thay cho các claim "responsive/contrast đã xanh" ở Tasks 20–24: jsdom không áp media query
(Ruling P20-2), nên chỉ browser thật mới được phép chốt 1440/1024/768/375.

| # | Surface | Ảnh | Kết quả |
|---|---|---|---|
| 1 | Welcome: icon, heading 34px, composer neo đáy, không card giữa màn hình | `01-welcome.png` | PASS |
| 2 | Lượt assistant hoàn tất: không bubble, copy/regenerate thật, không số liệu giả | `02-completed-turn.png` | PASS |
| 3 | Model picker: `fake-tools` / `fake-text`, không gọi mạng | `03-model-picker.png` | PASS |
| 4 | Search palette 768px, neo y≈128, section label thật | `04-search.png` | PASS |
| 5 | Dark mode: một palette, không gradient chữ, không emoji icon | `05-dark.png` | PASS |
| 6 | Settings: 5 tab, provider `fake` configured, không lộ key | `06-settings.png` | PASS |
| 7 | Mobile 375px: sidebar overlay + scrim đóng được | `07-mobile.png` | PASS |

## Đo trên browser, không đọc source

- **Contrast (spec §6.6.1):** duyệt mọi text node nhìn thấy được trên welcome, lượt assistant hoàn tất,
  Settings, Memory ở **cả light lẫn dark**; đọc `getComputedStyle(color)` + nền tổng hợp qua các tổ tiên
  (alpha composite), tính WCAG. Ngưỡng 4.5:1, 3:1 cho chữ ≥24px. **0 vi phạm.**
  Trước khi lấy mẫu: assert `document.visibilityState === 'visible'` và inject
  `*,*::before,*::after{transition:none!important;animation:none!important}` (R25-6) — nếu không,
  node `transition-colors` trả màu TRƯỚC khi đổi theme và báo lỗi giả.
- **Nguồn:** quét `client/src/**/*.ts(x)` (loại file `.test.*` vì fixture phải chứa chuỗi cấm để test
  detector, và loại dòng comment), cấm `bg-black/`, `border-white/`, `text-{green,amber,red}-*`,
  `text-brand-primary`, `text-*/20..60`. **0 vi phạm.**
- **Overflow:** `scrollWidth - clientWidth <= 1` tại 1440 / 1024 / 768 / 375. Tại 375 drawer mở dạng
  overlay và đóng được qua scrim (không phải control chết).
- **Console:** không có `console.error` và không có `pageerror` trong suốt phiên.

## Những gì gate NÀY không chốt (ghi rõ để không lặp lỗi round trước)

- Chưa kiểm app **đóng gói Electron** thật (`npm run dist` + cài portable) — thuộc Task 32/33.
- Không đo 34 tool của Studio MCP thật — fake mode chỉ có 3 tool, `e2e_echo` là tool giả có approval.
- CSS đóng gói vẫn còn một rule chết `.bg-black\/40` sinh từ literal trong fixture
  `layout/tokens.test.ts`; `@source not` của Tailwind 4.1.18 không loại được fixture này (đã thử tách
  thành 2 dòng, build ra CSS y hệt). Production JSX đã sạch. Ghi nợ Task 33.
- `eslint` vẫn exit 1 (16 problems / 14 errors) — nợ đã ghi ở verdict round 4, không thuộc gate này.
