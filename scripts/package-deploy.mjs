// Assemble the exact tree that gets deployed, then zip it.
//
// Deliberately explicit rather than "zip the repo and let Azure sort it out":
// what ships should be inspectable, and it must not contain .env, tests, the
// source, or 400MB of node_modules. Small deploys are also fast deploys, which
// matters when you are iterating on a config problem.
//
// Layout on the server:
//   /home/site/wwwroot/index.js       the bundled API + static server
//   /home/site/wwwroot/package.json   pg only
//   /home/site/wwwroot/dist/          the built SPA
//
// prod-server.ts resolves STATIC_DIR relative to cwd, which App Service sets to
// wwwroot, so `dist` sitting beside index.js is what it expects.

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = resolve(ROOT, 'deploy');
const ZIP = resolve(ROOT, 'deploy.zip');

for (const required of ['dist/index.html', 'server/index.js', 'server/package.json']) {
  if (!existsSync(resolve(ROOT, required))) {
    console.error(`Missing ${required}. Run: npm run build && npm run build:server`);
    process.exit(1);
  }
}

rmSync(STAGE, { recursive: true, force: true });
rmSync(ZIP, { force: true });
mkdirSync(STAGE, { recursive: true });

cpSync(resolve(ROOT, 'server/index.js'), join(STAGE, 'index.js'));
cpSync(resolve(ROOT, 'server/index.js.map'), join(STAGE, 'index.js.map'), { force: true });
cpSync(resolve(ROOT, 'server/package.json'), join(STAGE, 'package.json'));
cpSync(resolve(ROOT, 'dist'), join(STAGE, 'dist'), { recursive: true });

// Belt and braces. A .env in a deploy package would put the database password
// on a web server, and the whole point of App Service settings is that it lives
// in configuration instead.
const forbidden = ['.env', '.env.local', '.env.production'];
for (const name of forbidden) {
  if (existsSync(join(STAGE, name))) {
    console.error(`Refusing to package ${name}.`);
    process.exit(1);
  }
}

function bytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    total += s.isDirectory() ? bytes(full) : s.size;
  }
  return total;
}

console.log(`\nStaged ${(bytes(STAGE) / 1024 / 1024).toFixed(2)} MB in deploy/`);
for (const entry of readdirSync(STAGE)) console.log(`  ${entry}`);

// PowerShell's Compress-Archive is on every Windows box; no zip dependency.
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force`,
  ],
  { stdio: 'inherit' },
);

console.log(`\ndeploy.zip ready (${(statSync(ZIP).size / 1024 / 1024).toFixed(2)} MB)`);
