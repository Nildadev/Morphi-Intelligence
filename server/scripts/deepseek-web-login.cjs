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
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const STATIC_ORIGIN = 'https://fe-static.deepseek.com/chat/';
const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, '.deepseek-browser-profile');
const AUTH_FILE = path.join(ROOT, '.deepseek-auth.json');
const TIMEOUT_MS = Number(process.env.DEEPSEEK_LOGIN_TIMEOUT_MS || 300_000);
/** Rerun after an aborted attempt: keep the profile session so sign-in is instant. */
const KEEP_SESSION = process.env.DEEPSEEK_KEEP_SESSION === '1';

/** The `x-client-version` of the live web client, read from its bundle like the adapter does. */
let appVersion = '2.7.0';
async function refreshAppVersion(cookieHeader) {
  try {
    const home = await fetch(`${HOME_URL}/`, {
      headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader },
      signal: AbortSignal.timeout(10_000),
    });
    const bundle = /static\/main\.[0-9a-f]+\.js/.exec(await home.text())?.[0];
    if (!bundle) return;
    const js = await fetch(STATIC_ORIGIN + bundle, { signal: AbortSignal.timeout(10_000) });
    const found = /appVersion:"(\d+(?:\.\d+)+)"/.exec(await js.text())?.[1];
    if (found) appVersion = found;
  } catch {
    /* keep the fallback */
  }
}

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

/** Resolves with the Bearer of every successful /api/v0/ call, one candidate at a time. */
function tokenCandidates(context) {
  let notify = () => undefined;
  const queue = [];
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
      queue.push(auth.replace(/^Bearer\s+/i, '').trim());
      notify();
    } catch {
      /* keep listening */
    }
  };
  context.on('response', onResponse);
  return {
    next(deadlineMs) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          notify = () => undefined;
          resolve(undefined);
        }, Math.max(0, deadlineMs - Date.now()));
        notify = () => {
          if (queue.length === 0) return;
          clearTimeout(timer);
          notify = () => undefined;
          resolve(queue.shift());
        };
      });
    },
    stop() {
      context.off('response', onResponse);
    },
  };
}

/** The only proof a token is real: an authenticated call that answers code 0. */
async function tokenIsValid(token, cookieHeader) {
  try {
    const response = await fetch(`${HOME_URL}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: HOME_URL,
        Referer: `${HOME_URL}/`,
        Cookie: cookieHeader,
        'X-App-Version': appVersion,
        'x-client-platform': 'web',
        'x-client-version': appVersion,
        'x-client-locale': 'en',
        'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
    });
    const json = await response.json();
    const code = json?.code ?? json?.data?.code;
    if (typeof code === 'number' && code !== 0) {
      console.log(`[login]   validation answer: code=${code} msg=${json?.msg ?? json?.data?.biz_msg ?? ''}`);
      return false;
    }
    if (typeof json?.data?.biz_code === 'number' && json.data.biz_code !== 0) {
      console.log(`[login]   validation answer: biz_code=${json.data.biz_code} msg=${json.data.biz_msg ?? ''}`);
      return false;
    }
    // The id sits under biz_data.id or biz_data.chat_session.id depending on the response shape.
    const sessionId = json?.data?.biz_data?.id ?? json?.data?.biz_data?.chat_session?.id;
    if (!sessionId) {
      console.log(`[login]   validation answer: code 0 but no session id — keys: ${JSON.stringify(Object.keys(json?.data?.biz_data ?? {}))}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`[login]   validation request failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
    if (!KEEP_SESSION) {
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
    } else {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    console.log(`[login] waiting for sign-in (timeout=${Math.round(TIMEOUT_MS / 1000)}s)…`);
    // The app fires anonymous /api/v0/ calls with a guest Bearer BEFORE the sign-in completes, so a
    // captured token is only trusted after it proves itself against the API (the reference's
    // single-shot capture grabs the guest token on slower sign-ins).
    const candidates = tokenCandidates(context);
    let token;
    let cookieHeader;
    const deadline = Date.now() + TIMEOUT_MS;
    const seen = new Set();
    try {
      while (Date.now() < deadline) {
        cookieHeader = (await context.cookies(HOME_URL))
          .filter((c) => c?.name && typeof c.value === 'string')
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
        if (!cookieHeader.includes('ds_session_id=')) {
          await page.waitForTimeout(1500);
          continue;
        }
        await refreshAppVersion(cookieHeader);
        // The app stores the real token in localStorage once signed in — try it first.
        const stored = normalizeToken(await readLocalStorage(page, ['userToken', 'token', 'access_token']));
        const candidate = (stored && !seen.has(stored) ? stored : null) ?? (await candidates.next(deadline)) ?? null;
        if (!candidate || seen.has(candidate)) {
          await page.waitForTimeout(1000);
          continue;
        }
        seen.add(candidate);
        console.log(`[login] validating a candidate token (${candidate.length} chars, appVersion ${appVersion})…`);
        if (await tokenIsValid(candidate, cookieHeader)) {
          token = candidate;
          break;
        }
        console.log('[login] candidate rejected — still waiting for the sign-in');
      }
    } finally {
      candidates.stop();
    }

    if (!token) throw new Error('Sign-in timeout — no working token was captured. Complete the sign-in in the opened window and run again.');

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
