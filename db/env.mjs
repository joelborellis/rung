// Reading .env, with no side effects — importing this must never connect to
// anything or run a script.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal KEY=VALUE reader. No dependency; we do not need quoting rules. */
export function loadEnv(file = resolve(ROOT, '.env')) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    // Everything after the first '=' is the value: passwords contain '='.
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** .env, then real environment variables, which win. */
export function env() {
  return { ...loadEnv(), ...process.env };
}

/**
 * `DATABASE_URL` is the app's connection: the least-privilege `rung_app` role,
 * CRUD only. `ADMIN_DATABASE_URL` is the admin one, needed solely for DDL —
 * creating the database and running migrations.
 *
 * Keeping the conventional name for the low-privilege URL means the safe thing
 * is what you get by default, and reaching for admin is a visible choice.
 */
export function requireUrl(name = 'DATABASE_URL') {
  const value = env()[name];
  if (!value) {
    const hint =
      name === 'ADMIN_DATABASE_URL'
        ? ' This needs the admin role — only migrations and database creation use it.'
        : '';
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.${hint}`);
  }
  return value;
}
