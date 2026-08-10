// What does the owner actually see? Run after changing owner-facing UI.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { env as readEnv } from './env.mjs';

const APP = readEnv().APP_BASE_URL ?? 'http://localhost:5173';
const token = process.argv[2];
if (!token) {
  console.error('usage: node db/diagnose-owner.mjs <owner-token>');
  process.exit(1);
}
mkdirSync('artifacts', { recursive: true });

let failed = 0;
const check = (label, actual, expected) => {
  const good = actual === expected;
  if (!good) failed += 1;
  console.log(`  ${good ? 'ok  ' : 'BAD '} ${actual ? 'shown' : 'absent'}: ${label}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|DevTools/i.test(m.text())) {
    console.log(`  console.error: ${m.text()}`);
  }
});

await page.goto(`${APP}/#/t/${token}`, { waitUntil: 'networkidle' });
const begin = page.getByRole('button', { name: 'Begin review' });
if (await begin.isVisible().catch(() => false)) await begin.click();
await page.waitForSelector('header', { timeout: 10_000 });
await page.waitForTimeout(1500);

await page.screenshot({ path: 'artifacts/owner-arrival.png', fullPage: true });

let body = await page.textContent('body');
console.log('\nOn arrival:');
check('Batch progress dashboard', body.includes('Who has done what'), true);
check('"Add a counselor" prompt', body.includes('Add a counselor'), true);
check('reviewer guide (should not fight the dashboard)', body.includes('How to review'), false);

// Close the dashboard to reach the workspace underneath.
const close = page.getByRole('button', { name: 'Close', exact: true });
if (await close.isVisible().catch(() => false)) await close.click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'artifacts/owner-workspace.png', fullPage: true });

body = await page.textContent('body');
const header = await page.textContent('header');
console.log('\nIn the workspace, as owner:');
// Case-insensitive: eyebrow labels are uppercased by CSS, so textContent
// returns the source casing rather than what is on screen.
check('the scenario itself (needed to resolve)', /therapist envelope/i.test(body), true);
check('read-only explanation', body.includes("no verdict to record"), true);
check('verdict bar — "Save & next"', body.includes('Save & next'), false);
check('verdict bar — "Agree"', body.includes('Is this the right tier?'), false);
check('progress ring (0/29 would read as behind)', /\d+\/29/.test(header), false);
check('"Batch" button in the header', header.includes('Batch'), true);
// The owner does not review, so the chip must not say they are reviewing.
check('chip claiming "Reviewing as"', header.includes('Reviewing as'), false);
check('chip naming the owner role', /Owner/.test(header), true);

// The export panel should offer no personal review file.
await page.click('button:has-text("Export")');
await page.waitForTimeout(500);
await page.screenshot({ path: 'artifacts/owner-export.png', fullPage: true });
body = await page.textContent('body');
console.log('\nIn the Export panel, as owner:');
check('"Export my review file"', body.includes('Export my review file'), false);
check("\"Reviewers' work\" instead", body.includes("Reviewers' work"), true);
check('merged YAML export', body.includes('Export merged Input tiers YAML'), true);
check('owner tools', body.includes('Owner tools'), true);

await browser.close();
console.log(
  `\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}` +
    ' Screenshots: artifacts/owner-arrival.png, owner-workspace.png, owner-export.png\n',
);
process.exit(failed === 0 ? 0 : 1);
