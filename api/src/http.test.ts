// Cookie handling and error mapping. The cookie attributes here are a real
// security control, not formatting, and the error mapping is what stops an
// internal message reaching a clinician's browser.

import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  forbidden,
  parseCookies,
  requireObject,
  requireString,
  runHandler,
  serialiseCookie,
  type ApiRequest,
} from './http';

const REQUEST: ApiRequest = {
  method: 'GET',
  path: '/api/thing',
  query: new URLSearchParams(),
  headers: {},
  cookies: {},
  body: undefined,
};

describe('parseCookies', () => {
  it('reads several cookies', () => {
    expect(parseCookies('a=1; rung_sess=xyz; b=2')).toEqual({ a: '1', rung_sess: 'xyz', b: '2' });
  });

  it('decodes percent-encoding', () => {
    expect(parseCookies('x=a%20b')).toEqual({ x: 'a b' });
  });

  it('handles absent and malformed headers without throwing', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('novalue')).toEqual({});
  });

  it('keeps a base64url session value intact', () => {
    const value = 'eyJwaWQiOiJhYmMifQ.sig-with_underscores';
    expect(parseCookies(`rung_sess=${value}`).rung_sess).toBe(value);
  });
});

describe('serialiseCookie', () => {
  it('always sets HttpOnly and SameSite=Strict', () => {
    // Affordable only because the API is same-origin with the SPA. Losing
    // either attribute is a real regression, not a style change.
    const header = serialiseCookie({ name: 'rung_sess', value: 'v', maxAgeSeconds: 60 }, true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=60');
  });

  it('omits Secure off TLS, or localhost would never store the cookie', () => {
    expect(serialiseCookie({ name: 'a', value: 'b' }, false)).not.toContain('Secure');
    expect(serialiseCookie({ name: 'a', value: 'b' }, true)).toContain('Secure');
  });

  it('uses Expires for the delete case and drops Max-Age', () => {
    const header = serialiseCookie({ name: 'a', value: '', expires: new Date(0) }, true);
    expect(header).toContain('Expires=Thu, 01 Jan 1970');
    expect(header).not.toContain('Max-Age');
  });

  it('encodes a value containing a separator', () => {
    expect(serialiseCookie({ name: 'a', value: 'x;y' }, false)).toContain('a=x%3By');
  });
});

describe('runHandler', () => {
  it('passes a successful response through', async () => {
    const response = await runHandler(async () => ({ status: 200, body: { ok: true } }), REQUEST);
    expect(response).toEqual({ status: 200, body: { ok: true } });
  });

  it('keeps an ApiError message, because it was written for a clinician', async () => {
    const response = await runHandler(async () => {
      throw forbidden('That is an owner-only action.');
    }, REQUEST);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'That is an owner-only action.' },
    });
  });

  it('never leaks an unexpected error to the browser', async () => {
    // A stack trace or a connection string in a 500 body is a real leak.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await runHandler(async () => {
      throw new Error('postgres://admin:hunter2@host/db is unreachable');
    }, REQUEST);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(JSON.stringify(response.body)).not.toContain('postgres');
    expect(spy).toHaveBeenCalled(); // still logged server-side
    spy.mockRestore();
  });

  it('reports a custom status and code', async () => {
    const response = await runHandler(async () => {
      throw new ApiError(409, 'ID_TAKEN', 'That id is already assigned.');
    }, REQUEST);
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('ID_TAKEN');
  });
});

describe('body validation', () => {
  it('accepts an object', () => {
    expect(requireObject({ a: 1 }, 'a thing')).toEqual({ a: 1 });
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'hello'],
    ['undefined (no body sent)', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => requireObject(value, 'a thing')).toThrow(ApiError);
  });

  it('rejects a missing, blank, or non-string field', () => {
    expect(() => requireString(undefined, 'token')).toThrow(/"token" is required/);
    expect(() => requireString('   ', 'token')).toThrow(/"token" is required/);
    expect(() => requireString(42, 'token')).toThrow(/"token" is required/);
    expect(requireString('ok', 'token')).toBe('ok');
  });
});
