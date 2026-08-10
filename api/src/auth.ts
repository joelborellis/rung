// Who is this request, which batch are they in, and what may they do.
//
// Identity is global and participation is per-round, so resolving a request
// means two questions, not one: which person, and are they enrolled in the
// round that is currently open. A returning counselor whose batch has not
// started yet authenticates fine and is told to wait — that is not an error.

import { db, type Queryable } from './db';
import { forbidden, unauthorized, type ApiRequest } from './http';
import type { DbPersonRow } from './mappers';
import { SESSION_COOKIE, tokenMatches, tokenPrefix, verifySession } from './tokens';

export type Session = {
  person: DbPersonRow;
  role: 'reviewer' | 'owner';
  /** The open round, if there is one. */
  roundId: string | null;
  /** Whether this person is enrolled in that round. */
  enrolled: boolean;
};

const PERSON_COLUMNS = 'id, email, display_name, credentials, role';

export async function personById(id: string, client: Queryable = db()) {
  const result = await client.query<DbPersonRow & { revoked_at: Date | null }>(
    `select ${PERSON_COLUMNS}, revoked_at from people where id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Exchange an invite token for a person. Returns null for anything that is not
 * a live token — the caller must not distinguish "no such token" from
 * "revoked" in its response, or the endpoint becomes an oracle.
 */
export async function personByInviteToken(
  token: string,
  client: Queryable = db(),
): Promise<DbPersonRow | null> {
  const prefix = tokenPrefix(token);
  if (!prefix) return null;

  const result = await client.query<{
    token_hash: Buffer;
    invite_id: string;
    expires_at: Date | null;
    invite_revoked: Date | null;
    person_revoked: Date | null;
  } & DbPersonRow>(
    `select i.id as invite_id, i.token_hash, i.expires_at,
            i.revoked_at as invite_revoked, p.revoked_at as person_revoked,
            p.id, p.email, p.display_name, p.credentials, p.role
       from invites i
       join people p on p.id = i.person_id
      where i.token_prefix = $1`,
    [prefix],
  );

  const row = result.rows[0];
  // Still hash-compare on the miss path so a bad prefix and a bad secret cost
  // roughly the same.
  if (!row) {
    tokenMatches(token, Buffer.alloc(32));
    return null;
  }
  if (!tokenMatches(token, row.token_hash)) return null;
  if (row.invite_revoked || row.person_revoked) return null;
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;

  await client.query(
    `update invites set last_used_at = now(), use_count = use_count + 1 where id = $1`,
    [row.invite_id],
  );
  await client.query(`update people set last_seen_at = now() where id = $1`, [row.id]);

  return { id: row.id, email: row.email, display_name: row.display_name, credentials: row.credentials, role: row.role };
}

export async function openRoundId(client: Queryable = db()): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `select id from rounds where status = 'open' limit 1`,
  );
  return result.rows[0]?.id ?? null;
}

export async function sessionForPerson(
  person: DbPersonRow,
  client: Queryable = db(),
): Promise<Session> {
  const roundId = await openRoundId(client);
  if (!roundId) return { person, role: person.role, roundId: null, enrolled: false };

  const enrolled = await client.query(
    `select 1 from round_participants where round_id = $1 and person_id = $2`,
    [roundId, person.id],
  );
  // The owner is implicitly present in every round: they resolve and promote
  // without necessarily reviewing.
  return {
    person,
    role: person.role,
    roundId,
    enrolled: enrolled.rowCount! > 0 || person.role === 'owner',
  };
}

/** Resolve the session cookie, or 401. */
export async function requireSession(
  request: ApiRequest,
  client: Queryable = db(),
): Promise<Session> {
  const personId = verifySession(request.cookies[SESSION_COOKIE]);
  if (!personId) throw unauthorized('Your session has ended. Open your review link again.');

  const person = await personById(personId, client);
  if (!person) throw unauthorized('Your session has ended. Open your review link again.');
  if (person.revoked_at) {
    throw unauthorized('This link has been revoked. Ask Joel for a new one.');
  }

  return sessionForPerson(person, client);
}

/** As requireSession, and the person must be in the current batch. */
export async function requireActiveSession(
  request: ApiRequest,
  client: Queryable = db(),
): Promise<Session & { roundId: string }> {
  const session = await requireSession(request, client);
  if (!session.roundId) {
    throw forbidden('No review round is open right now. Joel will be in touch when the next set opens.');
  }
  if (!session.enrolled) {
    throw forbidden("You're not in the current batch. Joel will be in touch when the next set opens.");
  }
  return session as Session & { roundId: string };
}

export async function requireOwner(
  request: ApiRequest,
  client: Queryable = db(),
): Promise<Session> {
  const session = await requireSession(request, client);
  if (session.role !== 'owner') throw forbidden('That is an owner-only action.');
  return session;
}
