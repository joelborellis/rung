// Blind review, enforced server-side.
//
// A reviewer receives another counselor's verdict for scenario X only once
// they have saved their own verdict for X. This is not a UI preference: the
// whole point of collecting several clinicians' judgments is that they are
// independent, and §2 Goal 3 exists to make that disagreement computable. A
// reviewer who sees "JD proposed pause_and_route" before forming their own
// view is anchored, and the agreement percentage stops measuring anything.
//
// Enforced here rather than by hiding things in the client, because a control
// the browser applies is not a control. The response must not contain data the
// recipient is not entitled to, whatever the UI does with it.
//
// THE RULE, precisely — and note what it is NOT:
//
//   The server may SUBSET the list of overlays, and subset the key set within
//   an overlay's `reviews` map. It may never COMBINE two overlays, never read
//   or write a Scenario, and never compute a field the canon contains.
//
// Subsetting is not merging. A filtered ReviewOverlay is still a valid
// ReviewOverlay, which is why nothing downstream needs to change: contestedIds
// simply finds no other entries and draws no ring. Merging still happens only
// at export time, in the browser (spec §3).

import { db, type Queryable } from './db';
import {
  toOverlay,
  toResolution,
  type DbPersonRow,
  type DbProposalRow,
  type DbResolutionRow,
  type DbReviewRow,
} from './mappers';
import type { Resolution, ReviewOverlay } from '../../shared/review';

const REVIEW_COLUMNS = `
  r.round_id, r.person_id, r.scenario_id, r.file_kind, r.reviewed_at_iso,
  r.label_verdict, r.rationale_verdict, r.realism_verdict,
  r.hard_case, r.comment, r.proposed_text_edits`;

export type OverlayView = {
  overlays: ReviewOverlay[];
  resolutions: Record<string, Resolution>;
};

export type ViewerContext = {
  roundId: string;
  viewerId: string;
  /** Owners see everything: they resolve disagreement and cannot do it blind. */
  isOwner: boolean;
  /** ISO timestamp for delta sync, or null for everything. */
  since?: string | null;
};

/**
 * The predicate, as one WHERE clause.
 *
 * Kept in a single string used by every code path so there is exactly one
 * place the rule can be got wrong, and one place to read to check it.
 */
const VISIBLE_REVIEWS = `
  r.person_id = $2
  or r.scenario_id in (
       select scenario_id from reviews
        where round_id = $1 and person_id = $2
     )`;

async function loadPeople(
  client: Queryable,
  roundId: string,
): Promise<Map<string, DbPersonRow>> {
  const result = await client.query<DbPersonRow>(
    `select distinct p.id, p.email, p.display_name, p.credentials, p.role
       from round_participants rp
       join people p on p.id = rp.person_id
      where rp.round_id = $1
      order by p.display_name`,
    [roundId],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

export async function loadOverlayView(
  { roundId, viewerId, isOwner, since = null }: ViewerContext,
  client: Queryable = db(),
): Promise<OverlayView> {
  const people = await loadPeople(client, roundId);

  // Each branch carries its own parameter list rather than a shared one with
  // an unused slot: Postgres cannot infer the type of a parameter a statement
  // never references, and rejects the query outright.
  //
  // A revoked person's work is still data the owner needs, but their verdicts
  // are withheld from other reviewers along with everyone else's.
  const reviews = isOwner
    ? await client.query<DbReviewRow>(
        `select ${REVIEW_COLUMNS} from reviews r
          where r.round_id = $1
            and ($2::timestamptz is null or r.updated_at > $2::timestamptz)
          order by r.scenario_id`,
        [roundId, since],
      )
    : await client.query<DbReviewRow>(
        `select ${REVIEW_COLUMNS} from reviews r
           join people p on p.id = r.person_id
          where r.round_id = $1
            and p.revoked_at is null
            and (${VISIBLE_REVIEWS})
            and ($3::timestamptz is null or r.updated_at > $3::timestamptz)
          order by r.scenario_id`,
        [roundId, viewerId, since],
      );

  // Proposals are a counselor's own authored scenarios. They are not verdicts,
  // but they are opinion, and the rail only ever renders the viewer's own — so
  // withholding other people's costs nothing and closes a leak.
  const PROPOSAL_COLUMNS =
    'round_id, author_id, temp_id, target_file, status, scenario, assigned_id, accepted';
  const proposals = isOwner
    ? await client.query<DbProposalRow>(
        `select ${PROPOSAL_COLUMNS} from proposals
          where round_id = $1
            and ($2::timestamptz is null or updated_at > $2::timestamptz)
          order by temp_id`,
        [roundId, since],
      )
    : await client.query<DbProposalRow>(
        `select ${PROPOSAL_COLUMNS} from proposals
          where round_id = $1 and author_id = $2
            and ($3::timestamptz is null or updated_at > $3::timestamptz)
          order by temp_id`,
        [roundId, viewerId, since],
      );

  const byPerson = new Map<string, { reviews: DbReviewRow[]; proposals: DbProposalRow[] }>();
  const bucket = (id: string) => {
    let entry = byPerson.get(id);
    if (!entry) byPerson.set(id, (entry = { reviews: [], proposals: [] }));
    return entry;
  };
  for (const row of reviews.rows) bucket(row.person_id).reviews.push(row);
  for (const row of proposals.rows) bucket(row.author_id).proposals.push(row);

  const overlays: ReviewOverlay[] = [];
  for (const [personId, entry] of byPerson) {
    const person = people.get(personId);
    // A person with rows but no participant row should not exist — the FK
    // prevents it — but skipping beats emitting an overlay with no reviewer.
    if (!person) continue;
    overlays.push(toOverlay(person, entry.reviews, entry.proposals));
  }
  // Stable order so a poll that changed nothing produces an identical body.
  overlays.sort((a, b) => a.reviewer.displayName.localeCompare(b.reviewer.displayName));

  return {
    overlays,
    resolutions: await loadResolutions({ roundId, viewerId, isOwner }, client),
  };
}

/**
 * Resolutions are owner decisions about contested scenarios. The mere
 * existence of one for scenario X reveals that somebody contested X, so they
 * are filtered by the same visibility set as verdicts.
 */
async function loadResolutions(
  { roundId, viewerId, isOwner }: Omit<ViewerContext, 'since'>,
  client: Queryable,
): Promise<Record<string, Resolution>> {
  const columns = 'scenario_id, person_id, concern, decision, manual_value, resolved_at_iso';
  const result = isOwner
    ? await client.query<DbResolutionRow>(
        `select ${columns} from resolutions where round_id = $1`,
        [roundId],
      )
    : await client.query<DbResolutionRow>(
        `select ${columns} from resolutions
          where round_id = $1
            and scenario_id in (
                  select scenario_id from reviews where round_id = $1 and person_id = $2
                )`,
        [roundId, viewerId],
      );

  const out: Record<string, Resolution> = {};
  for (const row of result.rows) {
    const resolution = toResolution(row);
    out[resolution.key] = resolution;
  }
  return out;
}

/** The scenario ids a viewer has answered — what unlocks everyone else's. */
export async function visibleScenarioIds(
  roundId: string,
  viewerId: string,
  client: Queryable = db(),
): Promise<Set<string>> {
  const result = await client.query<{ scenario_id: string }>(
    'select scenario_id from reviews where round_id = $1 and person_id = $2',
    [roundId, viewerId],
  );
  return new Set(result.rows.map((row) => row.scenario_id));
}
