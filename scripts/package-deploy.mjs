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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
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

// Windows' own tar.exe (bsdtar, in System32 since Windows 10) writes a real zip
// with -a; no zip dependency. Not Compress-Archive: Windows PowerShell 5.1's
// version writes entry names with backslashes, and Azure's Linux build then
// treats "dist\index.html" as one filename and fails the deploy. The full path
// matters too: Git Bash puts GNU tar first on PATH, and that cannot write zip.
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(TAR, ['-a', '-c', '-f', ZIP, '-C', STAGE, ...readdirSync(STAGE)], { stdio: 'inherit' });

// Check the result rather than trusting the tool: read every entry name from
// the zip's central directory. A bad package otherwise only shows up as a
// failed deploy on the server.
const CENTRAL = Buffer.from('PK\x01\x02', 'latin1');
const zip = readFileSync(ZIP);
const names = [];
for (let at = zip.indexOf(CENTRAL); at !== -1; at = zip.indexOf(CENTRAL, at + 4)) {
  const nameLength = zip.readUInt16LE(at + 28);
  names.push(zip.toString('utf8', at + 46, at + 46 + nameLength));
}
const backslashed = names.filter((name) => name.includes('\\'));
if (backslashed.length > 0) {
  console.error(`deploy.zip has backslashes in entry names, which Linux cannot extract:\n  ${backslashed.join('\n  ')}`);
  process.exit(1);
}
for (const required of ['index.js', 'package.json', 'dist/index.html']) {
  if (!names.includes(required)) {
    console.error(`deploy.zip is missing ${required}. Entries:\n  ${names.join('\n  ')}`);
    process.exit(1);
  }
}

console.log(`\ndeploy.zip ready (${(statSync(ZIP).size / 1024 / 1024).toFixed(2)} MB)`);
