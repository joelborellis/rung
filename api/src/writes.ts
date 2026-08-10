// Write handlers: what the client's outbox actually calls.
//
// Two rules run through all of them.
//
// 1. Identity comes from the session, never the body. A client that sends
//    someone else's reviewerId has it silently replaced with their own.
// 2. file_kind is derived from the round's dataset, not trusted from the
//    client. That also validates the scenario exists in this batch, and keeps
//    the wire format exactly `ScenarioReview` — one shape for the API and the
//    .review.json both (§4.3 A).

import { db, transaction, type Queryable } from './db';
import { requireActiveSession, requireOwner, type Session } from './auth';
import {
  badRequest,
  conflict,
  forbidden,
  json,
  noContent,
  notFound,
  requireObject,
  type Handler,
} from './http';
import {
  INSERT_REVIEW_SQL,
  UPSERT_PROPOSAL_SQL,
  insertReviewParams,
  upsertProposalParams,
} from './mappers';
import { overlayToRows } from '../../shared/overlay';
import { resolutionKey, type ScenarioReview } from '../../shared/review';
import type { FileKind } from '../../shared/scenario';
import { parseProposal, parseResolution, parseScenarioReview, parseStringArray } from './validate';

/**
 * scenarioId -> which file it lives in, from the round's dataset.
 *
 * The server never parses YAML: `datasets.scenario_ids` is computed
 * client-side at upload and stored as opaque jsonb. This reads it back.
 */
async function fileKindMap(
  roundId: string,
  client: Queryable = db(),
): Promise<Map<string, FileKind>> {
  const result = await client.query<{ scenario_ids: { input: string[]; output: string[] } }>(
    `select d.scenario_ids from rounds r join datasets d on d.id = r.dataset_id where r.id = $1`,
    [roundId],
  );
  const ids = result.rows[0]?.scenario_ids;
  if (!ids) throw notFound('This round has no scenario set yet.');

  const map = new Map<string, FileKind>();
  for (const id of ids.input ?? []) map.set(id, 'input');
  for (const id of ids.output ?? []) map.set(id, 'output');
  return map;
}

/**
 * The owner administers; the counselors judge.
 *
 * The owner sees every verdict by design (§6.1) because resolving disagreement
 * cannot be done blind — which makes their own verdict worthless as data and
 * actively harmful to the agreement number. `round_participants` already makes
 * this structurally impossible (reviews carries an FK to it, and the owner has
 * no row), but that surfaces as a foreign-key error. This turns it into a rule
 * with an explanation.
 */
function refuseIfOwner(session: Session): void {
  if (session.role === 'owner') {
    throw forbidden(
      'The project owner administers the batch and does not record verdicts — you see every reviewer’s answer, so yours could not be independent.',
    );
  }
}

async function writeReview(
  client: Queryable,
  session: Session & { roundId: string },
  review: ScenarioReview,
  fileKinds: Map<string, FileKind>,
): Promise<{ applied: boolean }> {
  const rows = overlayToRows(
    { reviewer: { id: session.person.id, displayName: '' }, reviews: { x: review }, proposals: [] },
    { roundId: session.roundId, fileKindOf: (id) => fileKinds.get(id) },
  );
  if (rows.unplaced.length > 0) {
    throw badRequest('UNKNOWN_SCENARIO', `"${review.scenarioId}" is not in this round's scenarios.`);
  }

  const result = await client.query(INSERT_REVIEW_SQL, insertReviewParams(rows.reviews[0]!));
  // rowCount 0 means the conflict policy suppressed it: what is stored is
  // already at least as new. Not an error — the client's copy is just stale.
  return { applied: result.rowCount! > 0 };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * POST /api/reviews:batch — the outbox drain.
 *
 * One request per drain rather than one per verdict. Partial success is a
 * normal outcome and is reported per item, so a single bad row cannot strand
 * the whole queue: the client retires what applied and dead-letters the rest.
 */
export const postReviewsBatch: Handler = async (request) => {
  const session = await requireActiveSession(request);
  refuseIfOwner(session);
  const body = requireObject(request.body, 'a JSON object with "upserts" and/or "deletes"');

  const rawUpserts = body.upserts === undefined ? [] : body.upserts;
  if (!Array.isArray(rawUpserts)) throw badRequest('BAD_FIELD', '"upserts" must be an array.');
  if (rawUpserts.length > 500) {
    throw badRequest('TOO_MANY', 'Too many verdicts in one request. Sync will retry in batches.');
  }
  const deletes = parseStringArray(body.deletes, 'deletes');

  const fileKinds = await fileKindMap(session.roundId);
  const applied: string[] = [];
  const stale: string[] = [];
  const rejected: Array<{ scenarioId: string; code: string; message: string }> = [];

  await transaction(async (client) => {
    for (const raw of rawUpserts) {
      // Parse inside the loop so one malformed verdict is reported against its
      // own scenario rather than failing the batch.
      let review: ScenarioReview;
      try {
        review = parseScenarioReview(raw, session.person.id);
      } catch (error) {
        const scenarioId =
          typeof (raw as { scenarioId?: unknown })?.scenarioId === 'string'
            ? (raw as { scenarioId: string }).scenarioId
            : '(unknown)';
        rejected.push({
          scenarioId,
          code: 'INVALID',
          message: error instanceof Error ? error.message : 'Could not be saved.',
        });
        continue;
      }

      try {
        const { applied: didApply } = await writeReview(client, session, review, fileKinds);
        (didApply ? applied : stale).push(review.scenarioId);
      } catch (error) {
        rejected.push({
          scenarioId: review.scenarioId,
          code: 'REJECTED',
          message: error instanceof Error ? error.message : 'Could not be saved.',
        });
      }
    }

    for (const scenarioId of deletes) {
      await client.query(
        'delete from reviews where round_id = $1 and person_id = $2 and scenario_id = $3',
        [session.roundId, session.person.id, scenarioId],
      );
      applied.push(scenarioId);
    }
  });

  return json({ applied, stale, rejected, serverTime: new Date().toISOString() });
};

/** PUT /api/reviews/:scenarioId — single-verdict fallback. */
export const putReview: Handler = async (request) => {
  const session = await requireActiveSession(request);
  refuseIfOwner(session);
  const scenarioId = decodeURIComponent(request.path.slice('/api/reviews/'.length));
  const review = parseScenarioReview(request.body, session.person.id);
  if (review.scenarioId !== scenarioId) {
    throw badRequest('ID_MISMATCH', 'The scenario id in the URL and the body disagree.');
  }

  const { applied } = await writeReview(db(), session, review, await fileKindMap(session.roundId));
  return json({ scenarioId, applied, serverTime: new Date().toISOString() });
};

/** DELETE /api/reviews/:scenarioId — backs clearReview. */
export const deleteReview: Handler = async (request) => {
  const session = await requireActiveSession(request);
  const scenarioId = decodeURIComponent(request.path.slice('/api/reviews/'.length));
  await db().query(
    'delete from reviews where round_id = $1 and person_id = $2 and scenario_id = $3',
    [session.roundId, session.person.id, scenarioId],
  );
  // Idempotent: deleting something already gone is a success, because the
  // outbox may replay.
  return noContent();
};

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/** PUT /api/proposals/:tempId */
export const putProposal: Handler = async (request) => {
  const session = await requireActiveSession(request);
  // Authoring is a counselor's contribution too. The owner adds scenarios by
  // editing the canon, and assigns ids to others' proposals — which is an
  // update, not an insert, and stays available to them.
  refuseIfOwner(session);
  const tempId = decodeURIComponent(request.path.slice('/api/proposals/'.length));
  const proposal = parseProposal(request.body, session.person.id, {
    allowOwnerFields: session.role === 'owner',
  });
  if (proposal.tempId !== tempId) {
    throw badRequest('ID_MISMATCH', 'The proposal id in the URL and the body disagree.');
  }

  await db().query(
    UPSERT_PROPOSAL_SQL,
    upsertProposalParams({
      roundId: session.roundId,
      authorId: session.person.id,
      tempId: proposal.tempId,
      targetFile: proposal.targetFile,
      status: proposal.status,
      scenario: proposal.scenario,
      assignedId: null,
      accepted: null,
    }),
  );

  return json({ tempId, serverTime: new Date().toISOString() });
};

/** DELETE /api/proposals/:tempId — own proposals only. */
export const deleteProposal: Handler = async (request) => {
  const session = await requireActiveSession(request);
  const tempId = decodeURIComponent(request.path.slice('/api/proposals/'.length));
  await db().query(
    'delete from proposals where round_id = $1 and author_id = $2 and temp_id = $3',
    [session.roundId, session.person.id, tempId],
  );
  return noContent();
};

/**
 * POST /api/proposals/:tempId/assign — owner assigns a real scenario id.
 *
 * The unique index is what actually prevents two counselors' accepted
 * scenarios landing on the same id; this turns that into a 409 the UI can
 * retry with the next suggestion rather than a 500.
 */
export const assignProposal: Handler = async (request) => {
  const session = await requireOwner(request);
  if (!session.roundId) throw notFound('No round is open.');
  const tempId = decodeURIComponent(
    request.path.slice('/api/proposals/'.length, request.path.lastIndexOf('/assign')),
  );
  const body = requireObject(request.body, 'a JSON object with "assignedId"');
  const assignedId = typeof body.assignedId === 'string' ? body.assignedId : null;
  const accepted = typeof body.accepted === 'boolean' ? body.accepted : null;

  try {
    const result = await db().query(
      `update proposals set assigned_id = $3, accepted = $4, updated_at = now()
        where round_id = $1 and temp_id = $2 returning id`,
      [session.roundId, tempId, assignedId, accepted],
    );
    if (result.rowCount === 0) throw notFound('That proposed scenario no longer exists.');
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'proposals_assigned_id_unique') {
      throw conflict('ID_TAKEN', `"${assignedId}" is already assigned to another scenario.`);
    }
    throw error;
  }

  return json({ tempId, assignedId, accepted });
};

// ---------------------------------------------------------------------------
// Resolutions — owner only
// ---------------------------------------------------------------------------

/** PUT /api/resolutions/:key */
export const putResolution: Handler = async (request) => {
  const session = await requireOwner(request);
  if (!session.roundId) throw notFound('No round is open.');
  const key = decodeURIComponent(request.path.slice('/api/resolutions/'.length));
  const resolution = parseResolution(request.body);

  // The key embeds scenarioId, reviewerId and concern. Rebuilding it from the
  // parsed body and comparing catches a client that built it by hand.
  const expected = resolutionKey(resolution.scenarioId, resolution.reviewerId, resolution.concern);
  if (expected !== key) {
    throw badRequest('ID_MISMATCH', 'The resolution key does not match its contents.');
  }

  await db().query(
    `insert into resolutions (round_id, scenario_id, person_id, concern, decision,
                              manual_value, resolved_at_iso, resolved_at, resolved_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::text,$7::timestamptz,$8)
     on conflict (round_id, scenario_id, person_id, concern) do update set
       decision        = excluded.decision,
       manual_value    = excluded.manual_value,
       resolved_at_iso = excluded.resolved_at_iso,
       resolved_at     = excluded.resolved_at,
       resolved_by     = excluded.resolved_by`,
    [
      session.roundId,
      resolution.scenarioId,
      resolution.reviewerId,
      resolution.concern,
      resolution.decision,
      resolution.manualValue === undefined ? null : JSON.stringify(resolution.manualValue),
      resolution.resolvedAt,
      session.person.id,
    ],
  );

  return json({ key, serverTime: new Date().toISOString() });
};

/** DELETE /api/resolutions/:key */
export const deleteResolution: Handler = async (request) => {
  const session = await requireOwner(request);
  if (!session.roundId) throw notFound('No round is open.');
  const key = decodeURIComponent(request.path.slice('/api/resolutions/'.length));
  const [scenarioId, reviewerId, concern] = key.split('::');
  if (!scenarioId || !reviewerId || !concern) {
    throw badRequest('BAD_KEY', 'That is not a resolution key.');
  }

  await db().query(
    `delete from resolutions
      where round_id = $1 and scenario_id = $2 and person_id = $3 and concern = $4`,
    [session.roundId, scenarioId, reviewerId, concern],
  );
  return noContent();
};
