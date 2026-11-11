/* eslint-disable */
/** Probe: which stored credential part fails? Prints codes only, never secrets. */
const fs = require('node:fs');
const path = require('node:path');

const auth = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.deepseek-auth.json'), 'utf8'));
const BASE = 'https://chat.deepseek.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const headers = {
  'User-Agent': UA,
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: `${BASE}/`,
  Cookie: auth.cookieHeader,
  'x-client-platform': 'web',
  'x-client-version': '2.7.0',
  'x-client-locale': 'en',
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
};

(async () => {
  console.log('token length:', (auth.token ?? '').length, '| cookie names:', auth.cookieHeader.split(';').map((s) => s.trim().split('=')[0]).join(', '));

  const withToken = await fetch(`${BASE}/api/v0/chat_session/create`, { method: 'POST', headers, body: '{}' });
  const text = await withToken.text();
  const json = JSON.parse(text);
  console.log('create_session WITH token:', withToken.status, 'code:', json.code, 'biz_code:', json.data?.biz_code, 'msg:', json.msg || json.data?.biz_msg || '', 'session?', !!json.data?.biz_data?.id);

  const noAuth = { ...headers };
  delete noAuth.Authorization;
  const without = await fetch(`${BASE}/api/v0/chat_session/create`, { method: 'POST', headers: noAuth, body: '{}' });
  const json2 = JSON.parse(await without.text());
  console.log('create_session cookies-only:', without.status, 'code:', json2.code, 'biz_code:', json2.data?.biz_code, 'msg:', json2.msg || json2.data?.biz_msg || '', 'session?', !!json2.data?.biz_data?.id);
})().catch((err) => {
  console.error('probe failed —', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
