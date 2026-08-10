// Start both halves of the app with one command: `npm start`.
//
// The app needs two processes locally. The API holds the Postgres connection;
// Vite serves the SPA and proxies /api to it, so the browser talks to one
// origin exactly as it will in production. Running them separately is fine —
// this just saves remembering both, and shuts them down together.
//
// No dependency for this: `concurrently` would be a package to install and
// audit for something 40 lines of child_process does.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Fail here rather than letting the API boot, fail, and scroll away.
if (!existsSync(resolve(ROOT, '.env'))) {
  console.error(
    '\nNo .env found. The API needs the Azure Postgres connection string.\n' +
      '  cp .env.example .env    # then fill it in\n',
  );
  process.exit(1);
}
const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
for (const key of ['DATABASE_URL', 'SESSION_SECRET']) {
  if (!new RegExp(`^${key}=.+`, 'm').test(env)) {
    console.error(`\n${key} is missing from .env. See .env.example.\n`);
    process.exit(1);
  }
}

const children = [];
let shuttingDown = false;

function start(name, command, colour) {
  const child = spawn(command, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${colour}m${name.padEnd(4)}\x1b[0m`;

  const relay = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        // npm's own preamble is noise here; the child's real output is not.
        if (line.trim() === '' || /^> rung@|^> (vite|tsx)/.test(line)) continue;
        console.log(`${tag} │ ${line}`);
      }
    });
  };
  relay(child.stdout);
  relay(child.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${tag} │ exited (${code}) — stopping the other process too`);
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    // Windows needs the tree killed: `shell: true` means the direct child is
    // cmd.exe, and signalling that leaves node and vite orphaned.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 400);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

console.log('\nStarting the API (Azure Postgres) and the dev server.');
console.log('Open the invite link, not the bare URL — otherwise you get file-only mode.');
console.log('Ctrl+C stops both.\n');

start('api', 'npm run api:dev', '36'); // cyan
start('web', 'npm run dev', '35'); // magenta
