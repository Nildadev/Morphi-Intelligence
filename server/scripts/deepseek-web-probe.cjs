/* eslint-disable */
/** Read-only probe: does the REAL web UI of this same account still accept input, or is it muted there too? */
const path = require('node:path');
const { chromium } = require('playwright');

const HOME_URL = 'https://chat.deepseek.com';
const PROFILE_DIR = path.join(__dirname, '..', '.deepseek-browser-profile');

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(6000);
    const info = await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      const bodyText = document.body.innerText.slice(0, 1200);
      return {
        url: location.href,
        hasTextarea: !!textarea,
        textareaDisabled: textarea ? textarea.disabled : null,
        bodyText,
      };
    });
    console.log('url             :', info.url);
    console.log('textarea        :', info.hasTextarea ? 'present' : 'MISSING');
    console.log('textarea disabled:', info.textareaDisabled);
    console.log('--- page text (first 1200 chars) ---');
    console.log(info.bodyText);
  } finally {
    await context.close().catch(() => undefined);
  }
})().catch((err) => {
  console.error('probe failed —', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
