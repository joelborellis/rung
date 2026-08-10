import { beforeEach, describe, expect, it } from 'vitest';
import { clientKey, rateLimit, resetRateLimits } from './ratelimit';

beforeEach(() => {
  resetRateLimits();
});

const opts = (now: number) => ({ limit: 3, windowMs: 60_000, now });

describe('rateLimit', () => {
  it('allows up to the limit', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimit('a', opts(1000)).allowed).toBe(true);
    }
  });

  it('refuses past the limit and says how long to wait', () => {
    for (let i = 0; i < 3; i += 1) rateLimit('a', opts(1000));
    const result = rateLimit('a', opts(1000));
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it('counts each caller separately', () => {
    for (let i = 0; i < 3; i += 1) rateLimit('a', opts(1000));
    expect(rateLimit('b', opts(1000)).allowed).toBe(true);
  });

  it('lets a blocked caller back in after the window', () => {
    for (let i = 0; i < 4; i += 1) rateLimit('a', opts(1000));
    expect(rateLimit('a', opts(1000)).allowed).toBe(false);
    expect(rateLimit('a', opts(62_000)).allowed).toBe(true);
  });

  it('reports a shrinking wait as the window closes', () => {
    for (let i = 0; i < 4; i += 1) rateLimit('a', opts(1000));
    expect(rateLimit('a', opts(31_000)).retryAfterSeconds).toBe(30);
  });
});

describe('clientKey', () => {
  it('takes the first entry of x-forwarded-for — the client, not a proxy', () => {
    expect(clientKey({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' })).toBe('203.0.113.7');
  });

  it('trims whitespace', () => {
    expect(clientKey({ 'x-forwarded-for': '  203.0.113.7 ' })).toBe('203.0.113.7');
  });

  it('falls back rather than throwing when no header is present', () => {
    expect(clientKey({})).toBe('unknown');
  });
});
