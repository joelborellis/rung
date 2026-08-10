// Read-only schema dump — what actually exists in the database, as opposed to
// what the migration files say should. Run with `node db/inspect.mjs`.

import pg from 'pg';
import { requireUrl } from './env.mjs';

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();

const tables = await client.query(`
  select c.relname as table,
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = c.relname) as columns,
         (select count(*) from pg_index i where i.indrelid = c.oid) as indexes,
         pg_total_relation_size(c.oid) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname
`);
console.log('\nTables');
console.table(tables.rows);

const constraints = await client.query(`
  select conrelid::regclass::text as "table", conname as constraint,
         case contype when 'p' then 'primary key' when 'f' then 'foreign key'
                      when 'u' then 'unique' when 'c' then 'check' end as kind
    from pg_constraint
   where connamespace = 'public'::regnamespace
   order by 1, 3, 2
`);
console.log(`\nConstraints (${constraints.rowCount})`);
console.table(constraints.rows);

const applied = await client.query(
  'select filename, left(sha256, 12) as sha, applied_at from schema_migrations order by filename',
);
console.log('\nMigrations');
console.table(applied.rows);

await client.end();
