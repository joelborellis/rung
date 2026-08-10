// Route matching. The ordering hazards here are real: `/api/reviews:batch`
// must not be read as a scenario id called ":batch", and `/assign` must not be
// read as part of a tempId.

import { describe, expect, it } from 'vitest';
import { route } from './routes';
import type { ApiRequest } from './http';

const at = (method: string, path: string): ApiRequest => ({
  method,
  path,
  query: new URLSearchParams(),
  headers: {},
  cookies: {},
  body: undefined,
});

describe('route matching', () => {
  it.each([
    ['POST', '/api/session'],
    ['GET', '/api/session'],
    ['DELETE', '/api/session'],
    ['GET', '/api/dataset'],
    ['GET', '/api/bootstrap'],
    ['GET', '/api/overlays'],
    ['GET', '/api/health'],
    ['POST', '/api/reviews:batch'],
    ['PUT', '/api/reviews/routine-001'],
    ['DELETE', '/api/reviews/routine-001'],
    ['PUT', '/api/proposals/new-abc'],
    ['DELETE', '/api/proposals/new-abc'],
    ['POST', '/api/proposals/new-abc/assign'],
    ['PUT', '/api/resolutions/routine-001::uuid::label'],
    ['DELETE', '/api/resolutions/routine-001::uuid::label'],
    ['GET', '/api/admin/progress'],
    ['GET', '/api/admin/people'],
    ['POST', '/api/admin/people'],
    ['POST', '/api/admin/people/abc/revoke'],
    ['POST', '/api/admin/people/abc/reissue'],
    ['POST', '/api/admin/round/participants'],
    ['POST', '/api/admin/round/promote'],
    ['POST', '/api/admin/round'],
    ['POST', '/api/admin/dataset'],
    ['GET', '/api/admin/exports'],
    ['GET', '/api/admin/exports/abc'],
    ['POST', '/api/admin/overlays/import'],
    ['GET', '/api/admin/export/overlays'],
  ])('resolves %s %s', (method, path) => {
    expect(route(at(method, path))).not.toBeNull();
  });

  it('sends promote to its own handler, not the generic round route', () => {
    // Both are POST under /api/admin/round; promote is listed first. Getting
    // this wrong would treat "promote" as a batch label.
    const promote = route(at('POST', '/api/admin/round/promote'));
    const manage = route(at('POST', '/api/admin/round'));
    expect(promote).not.toBeNull();
    expect(promote).not.toBe(manage);
  });

  it('separates revoke from reissue', () => {
    expect(route(at('POST', '/api/admin/people/abc/revoke'))).not.toBe(
      route(at('POST', '/api/admin/people/abc/reissue')),
    );
  });

  it('resolves the batch route rather than treating it as an id', () => {
    // Listed before the parameterised route for exactly this reason.
    const batch = route(at('POST', '/api/reviews:batch'));
    const single = route(at('PUT', '/api/reviews/whatever'));
    expect(batch).not.toBeNull();
    expect(batch).not.toBe(single);
  });

  it('separates assign from a plain proposal write', () => {
    const assign = route(at('POST', '/api/proposals/new-abc/assign'));
    const put = route(at('PUT', '/api/proposals/new-abc'));
    expect(assign).not.toBeNull();
    expect(assign).not.toBe(put);
  });

  it.each([
    ['empty id', 'PUT', '/api/reviews/'],
    ['empty proposal id', 'PUT', '/api/proposals/'],
    ['empty resolution key', 'DELETE', '/api/resolutions/'],
    ['unknown path', 'GET', '/api/nope'],
    ['wrong method', 'POST', '/api/overlays'],
    ['wrong method on batch', 'GET', '/api/reviews:batch'],
    ['root', 'GET', '/'],
    ['api root', 'GET', '/api'],
  ])('returns null for %s', (_label, method, path) => {
    expect(route(at(method, path))).toBeNull();
  });

  it('does not let a traversal-looking path reach a handler it should not', () => {
    expect(route(at('GET', '/api/../api/overlays'))).toBeNull();
  });
});
