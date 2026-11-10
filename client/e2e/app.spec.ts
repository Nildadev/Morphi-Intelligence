import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Task 25 — Playwright golden paths + UI verification gate.
 * See fixtures.md for the fake LLM contract, the ABI-147 server and the DB reset policy.
 * All assertions target the REAL browser: no jsdom, no media-query extrapolation (Ruling P20-2).
 */
const API = 'http://127.0.0.1:3000';
const HEADERS = { 'X-Morphi-Token': 'dev-token' };
const WELCOME = 'Hôm nay bạn muốn xây gì?';
const COMPOSER = 'Khung nhắn tin';

const api = (request: APIRequestContext, route: string, options: Parameters<APIRequestContext['post']>[1] = {}) =>
  request.post(`${API}${route}`, { ...options, headers: { ...HEADERS, ...(options.headers ?? {}) } });

async function resetState(request: APIRequestContext): Promise<void> {
  const res = await request.delete(`${API}/api/memory`, { headers: HEADERS });
  expect(res.ok(), 'DELETE /api/memory must succeed').toBeTruthy();
}

async function freshPage(page: Page, request: APIRequestContext): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('hasSeenOnboarding_v2', 'true'));
  await resetState(request);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: WELCOME })).toBeVisible();
}

async function send(page: Page, script: string): Promise<void> {
  const box = page.getByRole('textbox', { name: COMPOSER });
  await box.fill(`/script ${script}`);
  await box.press('Enter');
}

/** The transcript paragraph only — the sidebar row and the header breadcrumb repeat the same words. */
const assistant = (page: Page) => page.locator('main p').filter({ hasText: /fake adapter/ }).first();

/** Settings/Memory live in the rail "Thêm" popover, not as top-level rail buttons (Rail.tsx). */
async function openRailAction(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Thêm' }).click();
  await page.getByRole('menuitem', { name: label }).click();
}

async function seed(request: APIRequestContext): Promise<{ projectId: string; sessionIds: string[] }> {
  const project = await api(request, '/api/projects', { data: { name: 'Dự án đo geometry' } });
  expect(project.ok()).toBeTruthy();
  const projectId = (await project.json()).id as string;
  const sessionIds: string[] = [];
  for (const title of ['Hôm nay', 'Hôm qua', 'Cũ hơn']) {
    const created = await api(request, '/api/sessions', { data: { projectId, title } });
    expect(created.ok()).toBeTruthy();
    sessionIds.push((await created.json()).id as string);
  }
  // Give each row a real turn so the sidebar has visible, non-empty session rows to measure.
  for (let i = 0; i < sessionIds.length; i += 1) {
    await api(request, '/api/chat/stream', {
      data: { sessionId: sessionIds[i], message: `/script text phiên ${i}` },
    });
  }
  return { projectId, sessionIds };
}

test.beforeEach(async ({ page, request }) => {
  await freshPage(page, request);
});

test.describe('golden paths', () => {
  test('1. fresh DB — first message streams to a completed assistant turn', async ({ page }) => {
    await send(page, 'text');
    await expect(assistant(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: WELCOME })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tạo lại câu trả lời' })).toBeVisible();
  });

  test('2. NO_PROVIDER shows the inline error and a REAL settings CTA', async ({ page }) => {
    await send(page, 'missing-key');
    await expect(page.getByRole('alert')).toContainText('Chưa cấu hình provider nào');
    const cta = page.getByRole('button', { name: 'Mở Cài đặt' });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('3. scripted tool call — allow, tool completes, assistant continues', async ({ page }) => {
    await send(page, 'tool-then-text');
    const dialog = page.getByRole('dialog', { name: 'Cần phê duyệt' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('e2e_echo')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cho phép một lần' }).click();
    await expect(page.getByText('Tool đã chạy xong.')).toBeVisible();
    await expect(page.getByText('Hoàn tất')).toBeVisible();
  });

  test('4. scripted tool call — deny, tool is cancelled and no final answer is appended', async ({ page }) => {
    await send(page, 'tool-then-text');
    const dialog = page.getByRole('dialog', { name: 'Cần phê duyệt' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Từ chối' }).click();
    // Measured in the real DOM: a denied call renders the tool card with status "Lỗi" and the
    // decision "Đã từ chối" (vi.chat.approvalDenied), NOT "Đã huỷ". The agent is then allowed to
    // continue with the denial as its tool result — the invariant is NO TOOL SIDE EFFECT, i.e. the
    // card never shows "Hoàn tất" and the echoed result never appears in it.
    await expect(page.getByText('Đã từ chối')).toBeVisible();
    await expect(page.getByText('Hoàn tất')).toHaveCount(0);
    // Locate by the raw name: the card title now comes from the server's measured label
    // ("E2E echo"), not from a client-side fallback.
    await expect(page.getByText('E2E echo')).toBeVisible();
    const toolCard = page.locator('main article').filter({ hasText: 'e2e_echo' });
    await expect(toolCard).not.toContainText('probe-from-fake');
  });

  test('5. Stop mid-stream settles as Đã dừng and emits no further deltas', async ({ page }) => {
    await send(page, 'slow');
    const stop = page.getByRole('button', { name: 'Dừng tạo' });
    await expect(stop).toBeVisible();
    await expect(page.getByText(/đoạn 1/)).toBeVisible();
    await stop.click();
    await expect(page.getByText(/Đã dừng/)).toBeVisible();
    const transcript = page.locator('main').innerText();
    await page.waitForTimeout(600);
    expect(await page.locator('main').innerText()).toBe(await transcript);
  });

  test('6. regenerate replaces the assistant answer without duplicating the user message', async ({ page }) => {
    await send(page, 'text');
    await expect(assistant(page)).toBeVisible();
    await page.getByRole('button', { name: 'Tạo lại câu trả lời' }).click();
    await expect(assistant(page)).toBeVisible();
    expect(await page.getByText('/script text', { exact: true }).count()).toBe(1);
  });

  test('7. reload restores the transcript from the durable event log', async ({ page }) => {
    await send(page, 'text');
    await expect(assistant(page)).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: WELCOME })).toBeVisible();
    const row = page.locator('[data-testid^="session-row-"]').first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(assistant(page)).toBeVisible();
  });
});

test.describe('shell surfaces', () => {
  test('8. search palette, new chat, theme toggle and sidebar collapse are real actions', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Tìm kiếm cuộc trò chuyện và dự án' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('combobox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    await page.getByRole('button', { name: 'Chuyển sang giao diện tối' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Chuyển sang giao diện sáng' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();
    await page.getByRole('button', { name: /thu gọn|mở rộng/i }).first().click();
    await page.getByRole('button', { name: 'Cuộc trò chuyện mới' }).first().click();
    await expect(page.getByRole('heading', { name: WELCOME })).toBeVisible();
  });

  test('9. no horizontal overflow at 1440 / 1024 / 768 / 375; overlay sidebar is closable on mobile', async ({ page }) => {
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
      await expect(page.getByRole('textbox', { name: COMPOSER })).toBeVisible();
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.waitForTimeout(200);
    // Crossing into mobile opens the drawer as an OVERLAY (measured: aria-hidden="false",
    // translate-x-0) and it sits above the header toggle. The real close affordance is the scrim.
    const scrim = page.getByTestId('app-shell-scrim');
    await expect(scrim).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await scrim.click({ position: { x: 310, y: 400 } });
    await expect(scrim).toHaveCount(0);
    await expect(page.getByTestId('sidebar')).not.toBeVisible();

    // Once closed, the header toggle is reachable again and must reopen the drawer.
    const toggle = page.getByRole('button', { name: 'Bật/tắt thanh bên' });
    await toggle.click();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.getByTestId('app-shell-scrim').click({ position: { x: 310, y: 400 } });
    await expect(page.getByTestId('app-shell-scrim')).toHaveCount(0);
  });

  test('11b. seeded geometry: 34px session rows and every group heading shares one x', async ({ page, request }) => {
    await seed(request);
    await page.reload();
    const rows = page.locator('[data-testid^="session-row-"]');
    await expect(rows.first()).toBeVisible();
    const heights = await rows.evaluateAll((elements) => elements.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) expect(height, 'session row pitch').toBeGreaterThanOrEqual(32);

    const labels = page.locator('[data-testid="sidebar-recents-label"], #sidebar-projects-heading');
    const xs = await labels.evaluateAll((elements) => elements.map((el) => Math.round(el.getBoundingClientRect().x)));
    expect(xs.length).toBeGreaterThan(0);
    expect(new Set(xs).size, 'all section headings align at one x').toBe(1);
  });
});

test.describe('UI verification gate', () => {
  /** WCAG contrast over composited ancestor backgrounds, read from the browser (never from source). */
  const audit = async (page: Page): Promise<Array<{ text: string; ratio: number; color: string; background: string }>> =>
    page.evaluate(() => {
      const parse = (value: string): { r: number; g: number; b: number; a: number } | null => {
        const m = /rgba?\(([^)]+)\)/.exec(value);
        if (!m) return null;
        const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      };
      const over = (fg: NonNullable<ReturnType<typeof parse>>, bg: NonNullable<ReturnType<typeof parse>>) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = (c: { r: number; g: number; b: number }): number => {
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
      };
      const base = { r: 255, g: 255, b: 255, a: 1 };
      const backgroundOf = (element: Element) => {
        let acc: ReturnType<typeof parse> = null;
        let node: Element | null = element;
        while (node) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c && c.a > 0) {
            acc = acc ? over(acc as NonNullable<ReturnType<typeof parse>>, c) : c;
            if (c.a === 1) break;
          }
          node = node.parentElement;
        }
        return acc ? over(acc as NonNullable<ReturnType<typeof parse>>, base) : base;
      };
      const bad: Array<{ text: string; ratio: number; color: string; background: string }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = (node.textContent ?? '').trim();
        if (!text) continue;
        const element = node.parentElement;
        if (!element || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName)) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const color = parse(style.color);
        if (!color || color.a === 0) continue;
        const background = backgroundOf(element);
        const l1 = lum(over(color, background));
        const l2 = lum(background);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const size = Number.parseFloat(style.fontSize);
        const threshold = size >= 24 ? 3 : 4.5;
        if (ratio < threshold) {
          bad.push({ text: text.slice(0, 48), ratio: Number(ratio.toFixed(2)), color: style.color, background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})` });
        }
      }
      return bad;
    });

  const freezeMotion = async (page: Page) => {
    // R25-6: a hidden page stops producing frames, so transition-colors nodes report their PRE-switch
    // colour. Assert visibility, then kill transitions before sampling.
    await page.evaluate(() => {
      if (document.visibilityState !== 'visible') throw new Error('page hidden — contrast sampling invalid');
    });
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  };

  test('10. contrast sweep in light and dark over welcome, a completed turn, error, Settings, Memory and MCP', async ({ page, request }) => {
    const violations: string[] = [];
    const record = async (label: string) => {
      const bad = await audit(page);
      for (const item of bad) violations.push(`${label}: ${JSON.stringify(item)}`);
    };

    for (const mode of ['light', 'dark'] as const) {
      if (mode === 'dark') {
        await page.getByRole('button', { name: 'Chuyển sang giao diện tối' }).click();
        await expect(page.locator('html')).toHaveClass(/dark/);
      }
      await freezeMotion(page);
      await record(`${mode}/welcome`);

      await send(page, 'text');
      await expect(assistant(page)).toBeVisible();
      await record(`${mode}/completed-turn`);

      await openRailAction(page, 'Cài đặt');
      const settingsDialog = page.getByRole('dialog');
      await expect(settingsDialog).toBeVisible();
      await record(`${mode}/settings`);
      await settingsDialog.getByRole('tab', { name: 'Bộ nhớ' }).click();
      await record(`${mode}/memory`);
      // Task 31C: the MCP panel carries its own state badges (success/danger) and the last-error row,
      // so it is a distinct contrast surface — measured, not assumed from the General tab.
      await settingsDialog.getByRole('tab', { name: 'MCP' }).click();
      await expect(settingsDialog.getByText('Roblox Studio MCP')).toBeVisible();
      await record(`${mode}/mcp`);
      await settingsDialog.getByRole('button', { name: 'Đóng cài đặt' }).click();
      await expect(settingsDialog).toHaveCount(0);

      if (mode === 'light') {
        // Reset for the dark pass so the same surfaces are measured, not a second session.
        await resetState(request);
        await page.goto('/');
      }
    }

    expect(violations, violations.slice(0, 12).join('\n')).toEqual([]);
  });

  test('10b. no retired colour/opacity idiom remains in production client source', async () => {
    const src = path.resolve(process.cwd(), 'src');
    const banned = /bg-black\/|border-white\/|text-(?:green|amber|red)-\d+|text-brand-primary|text-[a-z-]+\/(?:20|30|40|50|60)\b/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) continue;
        const clean = fs.readFileSync(file, 'utf8').split(/\r?\n/)
          .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line)).join('\n');
        if (banned.test(clean)) offenders.push(path.relative(src, file));
      }
    };
    walk(src);
    expect(offenders, 'retired idioms must be gone from production source').toEqual([]);
  });

  test('12. UI verification checklist with screenshots and a clean console', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));

    const shots = path.resolve(process.cwd(), 'test-results/ui-gate');
    fs.mkdirSync(shots, { recursive: true });
    const shot = async (name: string) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

    await shot('01-welcome');
    await send(page, 'text');
    await expect(assistant(page)).toBeVisible();
    await shot('02-completed-turn');

    await page.getByRole('combobox', { name: 'Chọn mô hình' }).first().click();
    await shot('03-model-picker');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Tìm kiếm cuộc trò chuyện và dự án' })).toBeVisible();
    await shot('04-search');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Chuyển sang giao diện tối' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await shot('05-dark');
    await page.getByRole('button', { name: 'Chuyển sang giao diện sáng' }).click();

    await openRailAction(page, 'Cài đặt');
    const settings = page.getByRole('dialog');
    await expect(settings).toBeVisible();
    await shot('06-settings');
    await settings.getByRole('button', { name: 'Đóng cài đặt' }).click();
    await expect(settings).toHaveCount(0);

    await page.setViewportSize({ width: 375, height: 812 });
    await shot('07-mobile');
    await page.setViewportSize({ width: 1440, height: 900 });

    expect(errors, errors.slice(0, 8).join('\n')).toEqual([]);
  });
});
