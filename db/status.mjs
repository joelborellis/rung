// What state is the workspace actually in? Run before a manual test session.

import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();

const round = await client.query(`
  select r.id, r.label, r.status, r.created_at,
         d.file_hash, d.scenario_ids,
         (select count(*) from round_participants rp where rp.round_id = r.id) as people,
         (select count(*) from reviews rv where rv.round_id = r.id) as verdicts
    from rounds r left join datasets d on d.id = r.dataset_id
   where r.status = 'open'`);

if (round.rowCount === 0) {
  console.log('\nNo open batch. Run `npm run db:seed`.\n');
} else {
  const r = round.rows[0];
  const ids = r.scenario_ids ?? { input: [], output: [] };
  console.log(`\nOpen batch: "${r.label}"`);
  console.log(`  canon:        ${ids.input.length} input + ${ids.output.length} output`);
  console.log(`  participants: ${r.people}`);
  console.log(`  verdicts:     ${r.verdicts}`);
}

const people = await client.query(`
  select p.display_name, p.email, p.role, p.revoked_at,
         (select count(*) from invites i where i.person_id = p.id and i.revoked_at is null) as live_links,
         (select string_agg(i.token_prefix, ', ') from invites i
           where i.person_id = p.id and i.revoked_at is null) as prefixes
    from people p order by p.role desc, p.display_name`);

console.log(`\nPeople (${people.rowCount})`);
for (const p of people.rows) {
  const flags = [
    p.role === 'owner' ? 'OWNER' : null,
    p.revoked_at ? 'revoked' : null,
    Number(p.live_links) === 0 ? 'NO LIVE LINK' : `${p.live_links} link(s): ${p.prefixes}`,
  ].filter(Boolean);
  console.log(`  ${p.display_name} <${p.email}> — ${flags.join(' · ')}`);
}

const other = await client.query(
  `select count(*)::int as n from rounds where status <> 'open'`,
);
console.log(`\nClosed/archived batches: ${other.rows[0].n}`);
console.log(`App:  ${readEnv().APP_BASE_URL ?? 'http://localhost:5173'}\n`);

await client.end();
