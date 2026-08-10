// Who is in this workspace, and what role do they hold?

import pg from 'pg';
import { requireUrl } from './env.mjs';

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();

const result = await client.query(`
  select p.display_name, p.email, p.role, p.revoked_at,
         (select count(*) from invites i
           where i.person_id = p.id and i.revoked_at is null) as live_links,
         (select count(*) from reviews rv where rv.person_id = p.id) as verdicts,
         (select count(*) from round_participants rp where rp.person_id = p.id) as batches
    from people p
   order by p.role desc, p.display_name`);

console.table(
  result.rows.map((row) => ({
    name: row.display_name,
    email: row.email,
    role: row.role,
    liveLinks: Number(row.live_links),
    verdicts: Number(row.verdicts),
    batches: Number(row.batches),
    revoked: row.revoked_at !== null,
  })),
);

const owners = result.rows.filter((r) => r.role === 'owner');
const reviewers = result.rows.filter((r) => r.role === 'reviewer');
console.log(`${owners.length} owner, ${reviewers.length} reviewer(s)`);

await client.end();
