// The endpoint table and its handlers.
//
// Every overlay response goes through loadOverlayView in blind.ts, which is
// the only place the visibility rule lives. Handlers here must not build their
// own overlay query — that is how a second, subtly different rule appears.

import { db } from './db';
import {
  requireActiveSession,
  requireSession,
  personByInviteToken,
  sessionForPerson,
} from './auth';
import {
  ApiError,
  badRequest,
  json,
  noContent,
  notFound,
  requireObject,
  requireString,
  type ApiRequest,
  type ApiResponse,
  type Handler,
  unauthorized,
} from './http';
import { clientKey, rateLimit } from './ratelimit';
import { loadOverlayView } from './blind';
import { toReviewer, type DbPersonRow } from './mappers';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSession } from './tokens';
import {
  assignProposal,
  deleteProposal,
  deleteResolution,
  deleteReview,
  postReviewsBatch,
  putProposal,
  putResolution,
  putReview,
} from './writes';
import {
  createPerson,
  exportOverlays,
  getExport,
  importOverlayFile,
  listExports,
  listPeople,
  manageRound,
  progress,
  promoteRound,
  reissueInvite,
  revokePerson,
  setParticipants,
  uploadDataset,
} from './admin';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** POST /api/session — exchange an invite token for a session cookie. */
const postSession: Handler = async (request) => {
  // Rate-limited before the body is even read: this is the only endpoint an
  // unauthenticated caller can reach that touches the database.
  const limit = rateLimit(`session:${clientKey(request.headers)}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    throw new ApiError(429, 'TOO_MANY', 'Too many attempts. Wait a minute and try again.');
  }

  const body = requireObject(request.body, 'a JSON object with a "token"');
  const token = requireString(body.token, 'token');

  const person = await personByInviteToken(token);
  // One message for every failure mode. Distinguishing "no such token" from
  // "revoked" would turn this endpoint into an oracle for guessing tokens.
  if (!person) throw unauthorized("That link isn't valid. Ask Joel for a new one.");

  const session = await sessionForPerson(person);
  return json(sessionBody(session.person, session.roundId, session.enrolled), {
    setCookies: [
      { name: SESSION_COOKIE, value: signSession(person.id), maxAgeSeconds: SESSION_MAX_AGE_SECONDS },
    ],
  });
};

/** GET /api/session — who am I, according to the cookie. */
const getSession: Handler = async (request) => {
  const session = await requireSession(request);
  return json(sessionBody(session.person, session.roundId, session.enrolled));
};

/** DELETE /api/session — sign out. */
const deleteSession: Handler = async () =>
  noContent({
    setCookies: [{ name: SESSION_COOKIE, value: '', expires: new Date(0) }],
  });

function sessionBody(person: DbPersonRow, roundId: string | null, enrolled: boolean) {
  return {
    // Never the email: it is the identity key and stays server-side.
    reviewer: toReviewer(person),
    role: person.role,
    roundId,
    enrolled,
  };
}

// ---------------------------------------------------------------------------
// Dataset — the canon, as raw text
// ---------------------------------------------------------------------------

/**
 * GET /api/dataset — the YAML for the open round.
 *
 * Served as raw text because export is a line-span patch over exactly these
 * bytes; a parsed representation would make AC-5/AC-6 unachievable. The client
 * paints from its embedded copy first and only swaps if the hash differs, so
 * this is never on the first-paint path.
 */
const getDataset: Handler = async (request) => {
  const session = await requireActiveSession(request);
  const result = await db().query<{
    id: string;
    input_yaml: string;
    output_yaml: string;
    file_hash: string;
    sha256: string;
    scenario_ids: { input: string[]; output: string[] };
  }>(
    `select d.id, d.input_yaml, d.output_yaml, d.file_hash, d.sha256, d.scenario_ids
       from rounds r join datasets d on d.id = r.dataset_id
      where r.id = $1`,
    [session.roundId],
  );

  const row = result.rows[0];
  if (!row) throw notFound('This round has no scenario set yet.');

  // Strong ETag on the content address: an unchanged canon costs one 304.
  const etag = `"${row.sha256}"`;
  if (request.headers['if-none-match'] === etag) {
    return { status: 304, headers: { ETag: etag } };
  }

  return json(
    {
      id: row.id,
      fileHash: row.file_hash,
      sha256: row.sha256,
      inputYaml: row.input_yaml,
      outputYaml: row.output_yaml,
      scenarioIds: row.scenario_ids,
    },
    { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } },
  );
};

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** GET /api/overlays?since=<iso> — redacted per the blind rule. */
const getOverlays: Handler = async (request) => {
  const session = await requireActiveSession(request);
  const since = request.query.get('since');
  if (since !== null && Number.isNaN(Date.parse(since))) {
    throw badRequest('BAD_SINCE', '"since" must be an ISO timestamp.');
  }

  const view = await loadOverlayView({
    roundId: session.roundId,
    viewerId: session.person.id,
    isOwner: session.role === 'owner',
    since,
  });

  return json({ ...view, serverTime: new Date().toISOString() });
};

/** GET /api/bootstrap — session, overlays and resolutions in one round trip. */
const getBootstrap: Handler = async (request) => {
  const session = await requireSession(request);
  if (!session.roundId || !session.enrolled) {
    return json({
      ...sessionBody(session.person, session.roundId, session.enrolled),
      overlays: [],
      resolutions: {},
      serverTime: new Date().toISOString(),
    });
  }

  const round = await db().query<{ label: string; file_hash: string | null }>(
    `select r.label, d.file_hash
       from rounds r left join datasets d on d.id = r.dataset_id
      where r.id = $1`,
    [session.roundId],
  );

  const view = await loadOverlayView({
    roundId: session.roundId,
    viewerId: session.person.id,
    isOwner: session.role === 'owner',
  });

  return json({
    ...sessionBody(session.person, session.roundId, session.enrolled),
    round: { id: session.roundId, label: round.rows[0]?.label ?? '' },
    datasetFileHash: round.rows[0]?.file_hash ?? null,
    ...view,
    serverTime: new Date().toISOString(),
  });
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

type Route = { method: string; handler: Handler } & (
  | { path: string }
  /** Matches `${prefix}<something>${suffix}`, with a non-empty middle. */
  | { prefix: string; suffix?: string }
);

const ROUTES: Route[] = [
  // Session
  { method: 'POST', path: '/api/session', handler: postSession },
  { method: 'GET', path: '/api/session', handler: getSession },
  { method: 'DELETE', path: '/api/session', handler: deleteSession },

  // Read
  { method: 'GET', path: '/api/dataset', handler: getDataset },
  { method: 'GET', path: '/api/bootstrap', handler: getBootstrap },
  { method: 'GET', path: '/api/overlays', handler: getOverlays },
  { method: 'GET', path: '/api/health', handler: async () => json({ ok: true }) },

  // Write. The batch route is listed before the parameterised one so
  // `/api/reviews:batch` is never read as a scenario id.
  { method: 'POST', path: '/api/reviews:batch', handler: postReviewsBatch },
  { method: 'PUT', prefix: '/api/reviews/', handler: putReview },
  { method: 'DELETE', prefix: '/api/reviews/', handler: deleteReview },

  // Assign before the bare proposal route, same reason.
  { method: 'POST', prefix: '/api/proposals/', suffix: '/assign', handler: assignProposal },
  { method: 'PUT', prefix: '/api/proposals/', handler: putProposal },
  { method: 'DELETE', prefix: '/api/proposals/', handler: deleteProposal },

  { method: 'PUT', prefix: '/api/resolutions/', handler: putResolution },
  { method: 'DELETE', prefix: '/api/resolutions/', handler: deleteResolution },

  // Owner only. Every handler re-checks with requireOwner; this table is not
  // the control, it is only the map.
  { method: 'GET', path: '/api/admin/progress', handler: progress },
  { method: 'GET', path: '/api/admin/people', handler: listPeople },
  { method: 'POST', path: '/api/admin/people', handler: createPerson },
  { method: 'POST', prefix: '/api/admin/people/', suffix: '/revoke', handler: revokePerson },
  { method: 'POST', prefix: '/api/admin/people/', suffix: '/reissue', handler: reissueInvite },
  { method: 'POST', path: '/api/admin/round/participants', handler: setParticipants },
  // Listed before the generic round route so "promote" is not read as a label.
  { method: 'POST', path: '/api/admin/round/promote', handler: promoteRound },
  { method: 'POST', path: '/api/admin/round', handler: manageRound },
  { method: 'POST', path: '/api/admin/dataset', handler: uploadDataset },
  { method: 'GET', path: '/api/admin/exports', handler: listExports },
  { method: 'GET', prefix: '/api/admin/exports/', handler: getExport },
  { method: 'POST', path: '/api/admin/overlays/import', handler: importOverlayFile },
  { method: 'GET', path: '/api/admin/export/overlays', handler: exportOverlays },
];

function matches(route: Route, request: ApiRequest): boolean {
  if (route.method !== request.method) return false;
  if ('path' in route) return route.path === request.path;

  const { prefix, suffix = '' } = route;
  if (!request.path.startsWith(prefix)) return false;
  if (!request.path.endsWith(suffix)) return false;
  // The id itself must be non-empty: /api/reviews/ is not a review.
  return request.path.length > prefix.length + suffix.length;
}

export function route(request: ApiRequest): Handler | null {
  // First match wins, so order in ROUTES is meaningful.
  return ROUTES.find((r) => matches(r, request))?.handler ?? null;
}

export const notFoundResponse: ApiResponse = {
  status: 404,
  body: { error: { code: 'NO_ROUTE', message: 'No such endpoint.' } },
};
