// Auth primitives. Every test here corresponds to a way someone could get in
// without a valid link, or a way a valid link could stop working.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_MAX_AGE_SECONDS,
  hashToken,
  mintInviteToken,
  signSession,
  tokenMatches,
  tokenPrefix,
  verifySession,
} from './tokens';

const SECRET = 'a'.repeat(43);

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

describe('mintInviteToken', () => {
  it('produces the documented shape', () => {
    const { token, prefix } = mintInviteToken();
    expect(token).toMatch(/^rung_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(token).toContain(`_${prefix}_`);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintInviteToken().token));
    expect(seen.size).toBe(500);
  });

  it('returns a hash of the whole token, not of the secret half', () => {
    const { token, hash } = mintInviteToken();
    expect(hash.equals(hashToken(token))).toBe(true);
    expect(hash.length).toBe(32);
  });
});

describe('tokenPrefix', () => {
  it('extracts the prefix from a well-formed token', () => {
    expect(tokenPrefix('rung_a1b2c3d4_' + 'x'.repeat(43))).toBe('a1b2c3d4');
  });

  it('tolerates surrounding whitespace from a copy-paste', () => {
    expect(tokenPrefix('  rung_a1b2c3d4_' + 'x'.repeat(43) + '\n')).toBe('a1b2c3d4');
  });

  it.each([
    ['empty', ''],
    ['not ours', 'ghp_abcdefghijklmnop'],
    ['no prefix', 'rung__' + 'x'.repeat(43)],
    ['prefix not hex', 'rung_zzzzzzzz_' + 'x'.repeat(43)],
    ['prefix wrong length', 'rung_a1b2_' + 'x'.repeat(43)],
    ['secret too short', 'rung_a1b2c3d4_short'],
    ['sql-ish', "rung_a1b2c3d4_' or 1=1 --"],
  ])('rejects %s', (_label, value) => {
    expect(tokenPrefix(value)).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('accepts the token it was minted from', () => {
    const { token, hash } = mintInviteToken();
    expect(tokenMatches(token, hash)).toBe(true);
  });

  it('rejects a different token', () => {
    const a = mintInviteToken();
    const b = mintInviteToken();
    expect(tokenMatches(a.token, b.hash)).toBe(false);
  });

  it('rejects a token altered by one character', () => {
    const { token, hash } = mintInviteToken();
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(tokenMatches(tampered, hash)).toBe(false);
  });

  it('returns false rather than throwing on a wrong-length hash', () => {
    // timingSafeEqual throws on length mismatch; the guard must catch it,
    // because the miss path in auth.ts compares against a zero buffer.
    const { token } = mintInviteToken();
    expect(tokenMatches(token, Buffer.alloc(8))).toBe(false);
    expect(tokenMatches(token, Buffer.alloc(32))).toBe(false);
  });
});

describe('session cookie', () => {
  const PERSON = '3f1a6d0e-0b2c-4a7d-9f11-8c2e5b7a1d34';

  it('round-trips the person id', () => {
    expect(verifySession(signSession(PERSON))).toBe(PERSON);
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSession(PERSON);
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(43));
    expect(verifySession(cookie)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    // The attack this stops: swap in someone else's person id and inherit
    // their overlay — or the owner's role.
    const cookie = signSession(PERSON);
    const [, sig] = cookie.split('.');
    const forged = Buffer.from(
      JSON.stringify({ pid: 'ffffffff-0000-0000-0000-000000000000', iat: Math.floor(Date.now() / 1000) }),
      'utf8',
    ).toString('base64url');
    expect(verifySession(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const cookie = signSession(PERSON);
    const dot = cookie.lastIndexOf('.');
    // Flip a character in the MIDDLE of the signature. Flipping the last one
    // is not a real edit: base64url's final character carries only four
    // meaningful bits for a 32-byte digest, so several spellings decode
    // identically. That made this test flaky about one run in sixty-four.
    const i = dot + 5;
    const flipped = cookie.slice(0, i) + (cookie[i] === 'A' ? 'B' : 'A') + cookie.slice(i + 1);
    expect(flipped).not.toBe(cookie);
    expect(verifySession(flipped)).toBeNull();
  });

  it('rejects every non-canonical spelling of a valid signature', () => {
    // The four-spellings problem above, pinned. Comparing encoded strings
    // rather than decoded buffers is what makes exactly one spelling valid.
    const cookie = signSession(PERSON);
    const last = cookie[cookie.length - 1]!;
    for (const alt of ['A', 'B', 'C', 'D'].filter((c) => c !== last)) {
      expect(verifySession(cookie.slice(0, -1) + alt)).toBeNull();
    }
    expect(verifySession(cookie)).toBe(PERSON);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no separator', 'notacookie'],
    ['empty body', '.abc'],
    ['not base64url json', 'Zm9v.YmFy'],
  ])('rejects %s', (_label, value) => {
    expect(verifySession(value as string | undefined)).toBeNull();
  });

  it('expires after the max age', () => {
    const issued = Date.UTC(2026, 0, 1);
    const cookie = signSession(PERSON, issued);
    const justInside = issued + (SESSION_MAX_AGE_SECONDS - 60) * 1000;
    const justOutside = issued + (SESSION_MAX_AGE_SECONDS + 60) * 1000;

    expect(verifySession(cookie, justInside)).toBe(PERSON);
    expect(verifySession(cookie, justOutside)).toBeNull();
  });

  it('refuses to sign when the secret is missing or weak', () => {
    // Failing loudly beats signing everything with a predictable key.
    vi.stubEnv('SESSION_SECRET', '');
    expect(() => signSession(PERSON)).toThrow(/SESSION_SECRET/);
    vi.stubEnv('SESSION_SECRET', 'tooshort');
    expect(() => signSession(PERSON)).toThrow(/SESSION_SECRET/);
  });
});
