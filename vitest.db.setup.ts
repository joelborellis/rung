// Load .env into process.env for the DB integration suite. Vitest does not do
// this on its own, and the API reads process.env.DATABASE_URL.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), '.env');

let text = '';
try {
  text = readFileSync(file, 'utf8');
} catch {
  throw new Error(
    'No .env found. Copy .env.example to .env and fill it in, or run `npm test` for the suite that needs no database.',
  );
}

for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  // Real environment variables win, so CI can override without editing .env.
  if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set in .env.');
