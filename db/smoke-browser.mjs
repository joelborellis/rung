// Drive the real app in a real browser.
//
// Everything else in this repo is tested below the UI. This is the only check
// that exercises what a counselor actually meets: the invite link in the
// address bar, the cookie the browser decides whether to keep, the pre-roll,
// and Save & next under a real click.
//
// Needs `npm run api:dev` and `npm run dev` running. Creates a scratch
// counselor and removes them afterwards.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const APP = readEnv().APP_BASE_URL ?? 'http://localhost:5173';
const SHOTS = 'artifacts/smoke';
const TAG = `browser-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

function mintToken() {
  const prefix = randomBytes(4).toString('hex');
  const token = `rung_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: createHash('sha256').update(token, 'utf8').digest() };
}

mkdirSync(SHOTS, { recursive: true });

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();
const made = [];

async function addPerson(name, role = 'reviewer') {
  const row = await db.query(
    `insert into people (email, display_name, role) values ($1,$2,$3) returning id`,
    [`${TAG}-${name.toLowerCase()}@example.com`, name, role],
  );
  const id = row.rows[0].id;
  made.push(id);
  const minted = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    id,
    minted.prefix,
    minted.hash,
  ]);
  return { id, token: minted.token, name };
}

let browser;
try {
  const round = await db.query(`select id, label from rounds where status = 'open'`);
  if (round.rowCount === 0) throw new Error('No open round. Run `npm run db:seed` first.');
  const roundId = round.rows[0].id;

  const jane = await addPerson('Jane Smoke');
  const ownerRow = await db.query(`select id from people where role = 'owner' limit 1`);
  let ownerToken = null;
  if (ownerRow.rowCount > 0) {
    // Mint a fresh owner link so we can drive the owner panels too.
    const minted = mintToken();
    await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
      ownerRow.rows[0].id,
      minted.prefix,
      minted.hash,
    ]);
    ownerToken = minted.token;
    // Deliberately NOT enrolled as a participant. §6.2: the owner administers
    // and never reviews, and requireActiveSession admits them on role rather
    // than enrollment — so they reach everything without a participation row.
    //
    // An earlier version of this file enrolled them "so the owner panels would
    // load". They load anyway, and that row survived the cleanup and then made
    // e2e-owner-no-review fail — a test that quietly broke the invariant
    // another test exists to protect.
  }

  await db.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
    roundId,
    jane.id,
  ]);

  browser = await chromium.launch();
  console.log(`\nBrowser smoke test (${APP})\n`);

  // ---------------------------------------------------------------- reviewer
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const inviteUrl = `${APP}/#/t/${jane.token}`;
  await page.goto(inviteUrl, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${SHOTS}/1-preroll.png`, fullPage: true });

  const heading = await page.textContent('h1').catch(() => null);
  if (heading?.includes('Before you start')) ok('the invite link lands on the content-note pre-roll');
  else bad('pre-roll', `h1 was ${JSON.stringify(heading)}`);

  const body = await page.textContent('body');
  if (body.includes('judge the coach')) ok('the judge-the-coach ground rule is shown');
  else bad('ground rule', 'not present on the pre-roll');
  if (body.includes('suicidal ideation')) ok('the §7 content note is shown');
  else bad('content note', 'not present on the pre-roll');
  if (body.includes('private database')) ok('the where-your-data-goes paragraph is shown');
  else bad('data-handling copy', 'not present');

  // The token must be gone from the address bar before anything else.
  const urlAfterLoad = page.url();
  if (!urlAfterLoad.includes('rung_')) ok('the token is scrubbed from the URL');
  else bad('token scrub', urlAfterLoad);

  // And it must not have survived into history either.
  const historyLen = await page.evaluate(() => history.length);
  if (historyLen <= 2) ok('no extra history entry holding the token');
  else bad('history', `length ${historyLen}`);

  await page.click('button:has-text("Begin review")');
  await page.waitForSelector('header', { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/2-workspace.png`, fullPage: true });
  ok('Begin review reaches the workspace');

  const header = await page.textContent('header');
  if (header.includes('Jane Smoke')) ok('the header names the invited reviewer');
  else bad('reviewer chip', header.slice(0, 200));
  if (!header.includes('switch')) ok('a reviewer is not offered "switch"');
  else bad('switch chip', 'reviewer was offered reviewer switching');

  // The guide auto-opens on first arrival at each file and covers the verdict
  // bar. Exact-name match: has-text() also matches rail buttons behind the
  // overlay, which then never become clickable.
  const guideClose = page.getByRole('button', { name: 'Close', exact: true });
  if (await guideClose.isVisible().catch(() => false)) {
    await guideClose.click();
    await page.waitForTimeout(300);
  }

  // ------------------------------------------------------------ Save & next
  await page.waitForSelector('text=Agree', { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/3-scenario.png`, fullPage: true });

  const save = page.getByRole('button', { name: 'Save & next' });
  if (!(await save.isVisible().catch(() => false))) {
    bad('verdict bar', 'Save & next not found — the workspace may not have rendered');
  } else {
    // AC-2's documented agree path: a, a, a answers each focused group and
    // moves on. Using it here rather than three clicks means the test
    // exercises the interaction the criterion actually names.
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('a');
      await page.waitForTimeout(80);
    }
    await page.screenshot({ path: `${SHOTS}/3b-answered.png`, fullPage: true });

    // Assert the state rather than assuming the input landed — a disabled
    // Save would make the timing check below pass for the wrong reason.
    if (await save.isEnabled()) {
      ok('three keystrokes answer all three questions and enable Save');
    } else {
      bad('AC-2 keystrokes', 'Save & next still disabled after a, a, a');
    }

    const start = Date.now();
    await save.click();
    const elapsed = Date.now() - start;
    if (elapsed < 1000) ok(`Save & next advances immediately (${elapsed}ms, no network wait)`);
    else bad('AC-2', `save took ${elapsed}ms`);
    await page.screenshot({ path: `${SHOTS}/4-after-save.png`, fullPage: true });
  }

  // The verdict must reach the database without any further interaction.
  let stored = 0;
  for (let i = 0; i < 20 && stored === 0; i += 1) {
    const rows = await db.query('select count(*)::int as n from reviews where person_id = $1', [
      jane.id,
    ]);
    stored = rows.rows[0].n;
    if (stored === 0) await new Promise((r) => setTimeout(r, 500));
  }
  if (stored > 0) ok(`the verdict reached Postgres on its own (${stored} row)`);
  else bad('sync', 'nothing was written to the database within 10s');

  const chip = await page.textContent('header');
  if (/Saved|unsent|Saving/.test(chip)) ok('the header shows a sync state');
  else bad('sync chip', 'no sync indicator in the header');

  // A refresh must not lose it, and must not ask who they are again.
  await page.reload({ waitUntil: 'networkidle' });
  const afterReload = await page.textContent('body');
  if (afterReload.includes('Jane Smoke')) ok('a refresh keeps the session (cookie survived)');
  else bad('session persistence', 'reviewer not recognised after reload');
  if (!afterReload.includes('Before you start')) ok('the pre-roll is not shown twice');
  else bad('pre-roll repeat', 'shown again after reload');

  await page.screenshot({ path: `${SHOTS}/5-after-reload.png`, fullPage: true });

  // ------------------------------------------------------------------- owner
  if (ownerToken) {
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const ownerErrors = [];
    ownerPage.on('pageerror', (e) => ownerErrors.push(e.message));

    await ownerPage.goto(`${APP}/#/t/${ownerToken}`, { waitUntil: 'networkidle' });
    const begin = ownerPage.locator('button:has-text("Begin review")');
    if (await begin.isVisible().catch(() => false)) await begin.click();
    await ownerPage.waitForSelector('header', { timeout: 10_000 });

    // Same auto-opening guide as the reviewer path; it covers the header.
    const ownerGuideClose = ownerPage.getByRole('button', { name: 'Close', exact: true });
    if (await ownerGuideClose.isVisible().catch(() => false)) {
      await ownerGuideClose.click();
      await ownerPage.waitForTimeout(300);
    }

    await ownerPage.click('button:has-text("Export")');
    await ownerPage.waitForTimeout(400);
    await ownerPage.screenshot({ path: `${SHOTS}/6-owner-export.png`, fullPage: true });

    const exportPanel = await ownerPage.textContent('body');
    if (exportPanel.includes('Batch progress')) ok('the owner sees owner tools in the export panel');
    else bad('owner tools', 'Batch progress button missing');

    // Scoped to the Export dialog: "Batch progress" also appears in the owner's
    // read-only note behind it, and an unscoped selector matches both.
    const inExport = ownerPage.getByLabel('Export').getByRole('button', { name: 'Batch progress' });
    if (await inExport.isVisible().catch(() => false)) {
      await inExport.click();
      await ownerPage.waitForTimeout(1200);
      await ownerPage.screenshot({ path: `${SHOTS}/7-dashboard.png`, fullPage: true });
      const dash = await ownerPage.textContent('body');
      if (dash.includes('Who has done what')) ok('the batch dashboard renders');
      else bad('dashboard', dash.slice(0, 300));
      if (dash.includes('Jane Smoke')) ok('the dashboard lists the counselor who just reviewed');
      else bad('dashboard rows', 'Jane Smoke not listed');

      await ownerPage.click('button:has-text("Manage counselors")');
      await ownerPage.waitForTimeout(1000);
      await ownerPage.screenshot({ path: `${SHOTS}/8-people.png`, fullPage: true });
      const people = await ownerPage.textContent('body');
      if (people.includes('Add a counselor')) ok('the counselor roster renders');
      else bad('people admin', people.slice(0, 300));
    }

    if (ownerErrors.length > 0) bad('owner console errors', ownerErrors.join('; ').slice(0, 300));
    else ok('no uncaught errors on the owner path');

    await ownerCtx.close();
  }

  // Ignore the noise every dev server produces; fail on real ones.
  const real = consoleErrors.filter(
    (e) => !/favicon|DevTools|Download the React DevTools/i.test(e),
  );
  if (real.length === 0) ok('no uncaught errors on the reviewer path');
  else bad('console errors', real.join('; ').slice(0, 400));

  await context.close();
} catch (error) {
  bad('harness', error.stack ?? error.message);
} finally {
  await browser?.close();
  if (made.length > 0) {
    await db.query('delete from reviews where person_id = any($1::uuid[])', [made]);
    await db.query('delete from round_participants where person_id = any($1::uuid[])', [made]);
    await db.query('delete from invites where person_id = any($1::uuid[])', [made]);
    await db.query('delete from people where id = any($1::uuid[])', [made]);
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${SHOTS}/`);
process.exit(failed === 0 ? 0 : 1);
