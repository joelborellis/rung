// After a firewall change: can everyone who should still reach the database?
//
// Tightening a shared server's firewall is easy to get wrong in a way that only
// shows up as someone else's project failing later. This checks each path that
// is supposed to work, by actually connecting.

import pg from 'pg';
import { requireUrl } from './env.mjs';

let failed = 0;

async function probe(label, url, database) {
  const target = new URL(url);
  if (database) target.pathname = `/${database}`;
  const client = new pg.Client({
    connectionString: target.toString(),
    connectionTimeoutMillis: 12_000,
  });
  try {
    await client.connect();
    const who = await client.query('select current_user, current_database()');
    console.log(
      `  ok    ${label}: ${who.rows[0].current_user} @ ${who.rows[0].current_database}`,
    );
    await client.end();
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}: ${error.message.split('\n')[0]}`);
    await client.end().catch(() => {});
  }
}

console.log('\nFrom this machine:');
await probe('app role -> rung', requireUrl('DATABASE_URL'));
await probe('admin -> rung', requireUrl('ADMIN_DATABASE_URL'));
// The other project on this server connects as the owner of its database.
// If the firewall change broke that, this is where it shows.
await probe('admin -> elevenlabs_music', requireUrl('ADMIN_DATABASE_URL'), 'elevenlabs_music');

console.log(
  failed === 0
    ? '\nAll expected paths still work.\n'
    : `\n${failed} path(s) broken. Restore with:\n` +
        '  az postgres flexible-server firewall-rule create -g StorageServices \\\n' +
        '    -s mcp-registry-postgres -n AllowAll --start-ip-address 0.0.0.0 \\\n' +
        '    --end-ip-address 255.255.255.255\n',
);
process.exit(failed === 0 ? 0 : 1);
