// Why are owner tools not showing? Inspect the live app state.

import { chromium } from 'playwright';
import { env as readEnv } from './env.mjs';

const APP = readEnv().APP_BASE_URL ?? 'http://localhost:5173';
const token = process.argv[2];
if (!token) {
  console.error('usage: node db/diagnose-owner.mjs <owner-token>');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  console.error: ${m.text()}`);
});

await page.goto(`${APP}/#/t/${token}`, { waitUntil: 'networkidle' });

const begin = page.getByRole('button', { name: 'Begin review' });
if (await begin.isVisible().catch(() => false)) await begin.click();
await page.waitForSelector('header', { timeout: 10_000 });

const guide = page.getByRole('button', { name: 'Close', exact: true });
if (await guide.isVisible().catch(() => false)) {
  await guide.click();
  await page.waitForTimeout(300);
}

// What the API says.
const session = await page.evaluate(async () => {
  const r = await fetch('/api/session', { credentials: 'same-origin' });
  return { status: r.status, body: await r.text() };
});
console.log(`\n/api/session -> ${session.status}`);
console.log(`  ${session.body}`);

await page.click('button:has-text("Export")');
await page.waitForTimeout(600);
await page.screenshot({ path: 'artifacts/diagnose-export.png', fullPage: true });

const body = await page.textContent('body');
console.log('\nExport panel contains:');
for (const label of [
  'Your review',
  'Canonical files',
  'Owner tools',
  'Batch progress',
  'Manage counselors',
  'Resolve contested items',
  'Agreement report',
  'Close batch and start the next',
  'produced by the project owner',
]) {
  console.log(`  ${body.includes(label) ? 'YES' : 'no '}  ${label}`);
}

await browser.close();
console.log('\nScreenshot: artifacts/diagnose-export.png\n');
