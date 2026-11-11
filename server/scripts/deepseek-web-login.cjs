/* eslint-disable */
/**
 * DeepSeek Web sign-in helper — ports AppsGanin/ai-free-vscode's DeepSeekAuthManager.login.
 *
 * Opens a headed Chrome with a persistent profile on chat.deepseek.com, waits for the sign-in,
 * captures the Bearer from the first successful /api/v0/ call (the only reliable signal that
 * sign-in completed) and reads the cookie jar. Writes server/.deepseek-auth.json with
 * {"token","cookieHeader"} — the exact shape the adapter's Settings key field takes.
 *
 * Run:  node scripts/deepseek-web-login.cjs
 * The secret never needs to be pasted anywhere by hand; the live-test script reads the file.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const HOME_URL = 'https://chat.deepseek.com';
const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, '.deepseek-browser-profile');
const AUTH_FILE = path.join(ROOT, '.deepseek-auth.json');
const TIMEOUT_MS = Number(process.env.DEEPSEEK_LOGIN_TIMEOUT_MS || 300_000);

/** Strips `Bearer`, quotes and JSON wrappers off a captured token. */
function normalizeToken(raw) {
  if (!raw) return undefined;
  let token = String(raw).trim().replace(/^Bearer\s+/i, '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  if (token.startsWith('{') || token.startsWith('[')) {
    try {
      const parsed = JSON.parse(token);
      token =
        typeof parsed === 'string'
          ? parsed
          : (parsed.access_token ?? parsed.accessToken ?? parsed.token ?? parsed.value ?? token);
    } catch {
      /* not JSON — keep as is */
    }
  }
  return token || undefined;
}

/** Resolves with the Bearer of the first successful /api/v0/ call, or undefined on timeout. */
function waitForAuthApiCall(context, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      context.off('response', onResponse);
      resolve(undefined);
    }, timeoutMs);
    const onResponse = async (response) => {
      try {
        if (!response.url().includes('/api/v0/') || response.status() !== 200) return;
        const headers = response.request().headers();
        const auth = headers['authorization'] ?? headers['Authorization'];
        if (!auth || !/^Bearer\s+\S{10,}/.test(auth)) return;
        const body = await response.json();
        const code = body?.code ?? body?.data?.code;
        if (typeof code === 'number' && code !== 0) return;
        if (typeof body?.data?.biz_code === 'number' && body.data.biz_code !== 0) return;
        clearTimeout(timer);
        context.off('response', onResponse);
        resolve(auth.replace(/^Bearer\s+/i, '').trim());
      } catch {
        /* keep waiting */
      }
    };
    context.on('response', onResponse);
  });
}

async function readLocalStorage(page, keys) {
  return page
    .evaluate((names) => {
      try {
        for (const name of names) {
          const value = localStorage.getItem(name);
          if (value) return value;
        }
      } catch { /* storage blocked on this origin */ }
      return null;
    }, keys)
    .catch(() => null);
}

async function launch() {
  const options = {
    headless: false,
    viewport: { width: 1280, height: 820 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'],
  };
  // The system Chrome is not flagged as automated, so OAuth and anti-bots let it through.
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel });
    } catch (err) {
      console.log(`[login] ${channel} failed (${String(err).split('\n')[0].slice(0, 120)}) — trying next`);
    }
  }
  return chromium.launchPersistentContext(PROFILE_DIR, options);
}

(async () => {
  console.log('[login] opening chat.deepseek.com — sign in inside the window that just opened');
  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    // Clear the old session first, otherwise a stale one reports success.
    await context.clearCookies().catch(() => undefined);
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch { /* storage blocked on this origin */ }
      })
      .catch(() => undefined);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });

    console.log(`[login] waiting for sign-in (timeout=${Math.round(TIMEOUT_MS / 1000)}s)…`);
    const token =
      (await waitForAuthApiCall(context, TIMEOUT_MS)) ??
      normalizeToken(
        await (async () => {
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            const value = await readLocalStorage(page, ['userToken', 'token', 'access_token']);
            if (value) return value;
            await page.waitForTimeout(700);
          }
          return null;
        })(),
      );

    const cookieHeader = (await context.cookies(HOME_URL))
      .filter((c) => c?.name && typeof c.value === 'string')
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    if (!cookieHeader.includes('ds_session_id=')) {
      throw new Error('ds_session_id cookie missing — sign-in incomplete. Run again and complete the sign-in.');
    }

    fs.writeFileSync(AUTH_FILE, JSON.stringify({ token: token || undefined, cookieHeader }, null, 2));
    console.log(`[login] success — token: ${token ? 'captured' : 'absent (cookies may still work)'}, cookies: ${cookieHeader.split(';').length} entries`);
    console.log(`[login] credential written to ${path.relative(process.cwd(), AUTH_FILE)}`);
    console.log('[login] next: node scripts/deepseek-web-live.ts  (or paste the JSON into Settings → deepseek-web)');
  } finally {
    await context.close().catch(() => undefined);
  }
})().catch((err) => {
  console.error(`[login] failed — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
