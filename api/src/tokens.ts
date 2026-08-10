// Invite tokens and session cookies.
//
// An invite token IS a counselor's identity. It is minted once per person and
// stays valid across every batch they are enrolled in — Joel never re-issues a
// link just because a new scenario set opened.
//
// The raw token is never stored. The prefix indexes the lookup and a SHA-256
// digest verifies it, the same shape as a GitHub personal access token: 256
// bits of entropy wants a fast digest, not a password KDF. There is nothing to
// brute-force offline that is cheaper than guessing the token itself.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX_BYTES = 4; // 8 hex characters, shown in the owner UI
const SECRET_BYTES = 32; // 256 bits

export type MintedToken = {
  /** Shown to the owner exactly once, then unrecoverable. */
  token: string;
  /** Indexed for lookup; safe to display and to log. */
  prefix: string;
  /** What goes in invites.token_hash. */
  hash: Buffer;
};

export function mintInviteToken(): MintedToken {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `rung_${prefix}_${secret}`;
  return { token, prefix, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The prefix to look up, or null if this could not be one of our tokens. */
export function tokenPrefix(token: string): string | null {
  const match = /^rung_([0-9a-f]{8})_[A-Za-z0-9_-]{20,}$/.exec(token.trim());
  return match ? match[1]! : null;
}

/** Constant-time, and safe on length mismatch (timingSafeEqual throws). */
export function tokenMatches(token: string, storedHash: Buffer): boolean {
  const candidate = hashToken(token);
  if (candidate.length !== storedHash.length) return false;
  return timingSafeEqual(candidate, storedHash);
}

// ---------------------------------------------------------------------------
// Session cookie
//
// Stateless and signed rather than a sessions table: every authenticated
// request already loads the person row to resolve their round and role, so
// revocation is checked there. A table would add a write per request and buy
// nothing.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'rung_sess';
/** Long enough that a counselor is never logged out mid-batch. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or too short (need >= 32 chars). Generate one with:\n' +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
  return secret;
}

type SessionPayload = { pid: string; iat: number };

export function signSession(personId: string, now = Date.now()): string {
  const payload: SessionPayload = { pid: personId, iat: Math.floor(now / 1000) };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The person id, or null if the cookie is absent, tampered with, or expired. */
export function verifySession(cookie: string | undefined, now = Date.now()): string | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot < 1) return null;

  const body = cookie.slice(0, dot);
  // Compare the ENCODED signatures, not the decoded bytes.
  //
  // A 32-byte digest is 43 base64url characters, but 43 x 6 = 258 bits for 256
  // bits of data: the final character's low two bits are padding, which the
  // decoder discards. So four different strings — ...A, ...B, ...C, ...D —
  // decode to the same buffer and would all verify. Not forgeable into a
  // different payload, but it means one signature has several valid spellings,
  // which is a needless sharp edge. Comparing strings admits exactly one.
  const provided = Buffer.from(cookie.slice(dot + 1), 'utf8');
  const expected = Buffer.from(
    createHmac('sha256', sessionSecret()).update(body).digest('base64url'),
    'utf8',
  );
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.pid !== 'string' || typeof payload?.iat !== 'number') return null;
  if (Math.floor(now / 1000) - payload.iat > SESSION_MAX_AGE_SECONDS) return null;

  return payload.pid;
}
