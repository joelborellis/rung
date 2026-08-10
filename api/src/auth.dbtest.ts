// The authorization matrix.
//
// Three separate gates, each answering a different question, each with its own
// failure mode:
//   requireSession       — is this anyone at all?          (401)
//   requireActiveSession — are they in the current batch?  (403)
//   requireOwner         — may they resolve and promote?   (403)
//
// The copy matters as much as the status code: a counselor who arrives between
// batches has done nothing wrong and should not be told their link is broken.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  personByInviteToken,
  requireActiveSession,
  requireOwner,
  requireSession,
  sessionForPerson,
} from './auth';
import { ApiError, type ApiRequest } from './http';
import { SESSION_COOKIE, mintInviteToken, signSession } from './tokens';

vi.stubEnv('SESSION_SECRET', process.env.SESSION_SECRET ?? 'x'.repeat(43));

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
afterAll(async () => {
  await client.end();
});

function request(cookie?: string): ApiRequest {
  return {
    method: 'GET',
    path: '/api/overlays',
    query: new URLSearchParams(),
    headers: {},
    cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
    body: undefined,
  };
}

async function person(name: string, role: 'reviewer' | 'owner' = 'reviewer') {
  const row = await client.query(
    `insert into people (email, display_name, role) values ($1, $2, $3) returning id`,
    [`${name.toLowerCase()}-${randomUUID()}@example.com`, name, role],
  );
  return row.rows[0].id as string;
}

async function mintFor(personId: string) {
  const minted = mintInviteToken();
  await client.query(
    `insert into invites (person_id, token_prefix, token_hash) values ($1, $2, $3)`,
    [personId, minted.prefix, minted.hash],
  );
  return minted.token;
}

/** Expect a thrown ApiError with a given status. Returns it for copy checks. */
async function expectStatus(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
    throw new Error(`expected ${status}, but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
}

beforeEach(async () => {
  await client.query('begin');
  return async () => {
    await client.query('rollback');
  };
});

describe('requireSession — 401', () => {
  it('rejects no cookie', async () => {
    await expectStatus(requireSession(request(), client), 401);
  });

  it('rejects a forged cookie', async () => {
    await expectStatus(requireSession(request('garbage.signature'), client), 401);
  });

  it('rejects a validly signed cookie for a person who does not exist', async () => {
    // Deleting a person must not leave a working session behind.
    const ghost = signSession('00000000-0000-0000-0000-000000000000');
    await expectStatus(requireSession(request(ghost), client), 401);
  });

  it('rejects a revoked person and says so plainly', async () => {
    const id = await person('Revoked');
    await client.query('update people set revoked_at = now() where id = $1', [id]);
    const error = await expectStatus(requireSession(request(signSession(id)), client), 401);
    expect(error.message).toMatch(/revoked/i);
  });

  it('accepts a live person', async () => {
    const id = await person('Live');
    const session = await requireSession(request(signSession(id)), client);
    expect(session.person.id).toBe(id);
    expect(session.role).toBe('reviewer');
  });
});

describe('requireActiveSession — 403', () => {
  async function openRound() {
    await client.query(`update rounds set status = 'closed' where status = 'open'`);
    const row = await client.query(
      `insert into rounds (label) values ('auth test') returning id`,
    );
    return row.rows[0].id as string;
  }

  it('turns away a valid person when no batch is open, without blaming them', async () => {
    await client.query(`update rounds set status = 'closed' where status = 'open'`);
    const id = await person('Between');
    const error = await expectStatus(requireActiveSession(request(signSession(id)), client), 403);
    expect(error.message).toMatch(/no review round is open/i);
  });

  it('turns away someone not enrolled in the current batch', async () => {
    await openRound();
    const id = await person('NotInvited');
    const error = await expectStatus(requireActiveSession(request(signSession(id)), client), 403);
    expect(error.message).toMatch(/not in the current batch/i);
    expect(error.message).not.toMatch(/error|invalid|denied/i);
  });

  it('admits an enrolled person', async () => {
    const roundId = await openRound();
    const id = await person('Enrolled');
    await client.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
      roundId,
      id,
    ]);
    const session = await requireActiveSession(request(signSession(id)), client);
    expect(session.roundId).toBe(roundId);
    expect(session.enrolled).toBe(true);
  });

  it('admits the owner without an explicit enrollment row', async () => {
    // The owner resolves and promotes; they are implicitly present in every
    // batch whether or not they review.
    await openRound();
    const id = await person('Olive', 'owner');
    const session = await requireActiveSession(request(signSession(id)), client);
    expect(session.enrolled).toBe(true);
  });
});

describe('requireOwner — 403', () => {
  it('refuses a reviewer', async () => {
    const id = await person('JustAReviewer');
    const error = await expectStatus(requireOwner(request(signSession(id)), client), 403);
    expect(error.message).toMatch(/owner-only/i);
  });

  it('refuses an unauthenticated caller with 401, not 403', async () => {
    // Order matters: "who are you" is answered before "may you".
    await expectStatus(requireOwner(request(), client), 401);
  });

  it('admits the owner', async () => {
    const id = await person('Olive', 'owner');
    expect((await requireOwner(request(signSession(id)), client)).role).toBe('owner');
  });
});

describe('personByInviteToken', () => {
  it('resolves a live token and records the use', async () => {
    const id = await person('Linked');
    const token = await mintFor(id);

    expect((await personByInviteToken(token, client))?.id).toBe(id);

    const invite = await client.query(
      'select use_count, last_used_at from invites where person_id = $1',
      [id],
    );
    expect(invite.rows[0].use_count).toBe(1);
    expect(invite.rows[0].last_used_at).not.toBeNull();
  });

  it('works for a person enrolled in no round — identity is not enrollment', async () => {
    // The durable-link promise: the same link keeps resolving between batches.
    const id = await person('Returning');
    const token = await mintFor(id);
    const found = await personByInviteToken(token, client);
    expect(found?.id).toBe(id);

    const session = await sessionForPerson(found!, client);
    expect(session.person.id).toBe(id);
  });

  it.each([
    ['a token that was never minted', () => Promise.resolve(mintInviteToken().token)],
    ['a structurally invalid token', () => Promise.resolve('not-a-token')],
    ['an empty string', () => Promise.resolve('')],
  ])('returns null for %s', async (_label, make) => {
    expect(await personByInviteToken(await make(), client)).toBeNull();
  });

  it('returns null for a revoked invite', async () => {
    const id = await person('Rescinded');
    const token = await mintFor(id);
    await client.query('update invites set revoked_at = now() where person_id = $1', [id]);
    expect(await personByInviteToken(token, client)).toBeNull();
  });

  it('returns null for an expired invite', async () => {
    const id = await person('Expired');
    const token = await mintFor(id);
    await client.query(
      `update invites set expires_at = now() - interval '1 day' where person_id = $1`,
      [id],
    );
    expect(await personByInviteToken(token, client)).toBeNull();
  });

  it('returns null when the person is revoked, even though the invite is live', async () => {
    const id = await person('PersonGone');
    const token = await mintFor(id);
    await client.query('update people set revoked_at = now() where id = $1', [id]);
    expect(await personByInviteToken(token, client)).toBeNull();
  });

  it("rejects a token whose secret half is wrong but whose prefix is right", async () => {
    // The prefix is public — it is shown in the owner UI. Only the digest of
    // the whole token may grant access.
    const id = await person('PrefixOnly');
    const token = await mintFor(id);
    const prefix = token.split('_')[1];
    const forged = `rung_${prefix}_${'A'.repeat(43)}`;
    expect(await personByInviteToken(forged, client)).toBeNull();
  });
});
