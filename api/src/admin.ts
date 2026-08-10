// Owner-only endpoints: the roster, the progress dashboard, and the batch
// cycle.
//
// Every handler here goes through requireOwner. The client also hides these
// surfaces, but that is cosmetic — the control is this check plus the blind
// filter, which together mean an unhidden button gets a 403 rather than data.

import { db, transaction, type Queryable } from './db';
import { requireOwner } from './auth';
import {
  badRequest,
  conflict,
  json,
  noContent,
  notFound,
  requireObject,
  requireString,
  type Handler,
} from './http';
import { mintInviteToken } from './tokens';
import { toOverlay, type DbPersonRow, type DbProposalRow, type DbReviewRow } from './mappers';
import { REVIEW_FILE_VERSION, type ReviewFile } from '../../shared/review';
import { mergeOverlayInto } from '../../shared/overlay';
import { createHash } from 'node:crypto';

const PERSON_COLUMNS = 'id, email, display_name, credentials, role';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function openRound(client: Queryable = db()): Promise<{ id: string; label: string }> {
  const result = await client.query<{ id: string; label: string }>(
    `select id, label from rounds where status = 'open'`,
  );
  const round = result.rows[0];
  if (!round) throw notFound('No batch is open. Open one before doing this.');
  return round;
}

// ---------------------------------------------------------------------------
// People and invites
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/people — the global roster.
 *
 * Includes people not in the current batch: identity outlives a round, and
 * enrolling batch 3 means ticking names that already exist.
 */
export const listPeople: Handler = async (request) => {
  await requireOwner(request);
  const round = await db()
    .query<{ id: string }>(`select id from rounds where status = 'open'`)
    .then((r) => r.rows[0]?.id ?? null);

  const result = await db().query(
    `select p.id, p.email, p.display_name, p.credentials, p.role,
            p.created_at, p.last_seen_at, p.revoked_at,
            (select count(*) from invites i
              where i.person_id = p.id and i.revoked_at is null) as live_invites,
            (select max(i.last_used_at) from invites i where i.person_id = p.id) as link_last_used,
            (select count(*) from round_participants rp
              where rp.person_id = p.id) as rounds_joined,
            ($1::uuid is not null and exists (
               select 1 from round_participants rp
                where rp.person_id = p.id and rp.round_id = $1
             )) as in_current_batch
       from people p
      order by p.display_name`,
    [round],
  );

  return json({
    roundId: round,
    people: result.rows.map((row) => ({
      id: row.id,
      // The owner needs the email — it is the identity key they invited.
      email: row.email,
      displayName: row.display_name,
      credentials: row.credentials,
      role: row.role,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revoked: row.revoked_at !== null,
      hasLiveLink: Number(row.live_invites) > 0,
      linkLastUsed: row.link_last_used,
      linkStatus: linkStatus(row),
      roundsJoined: Number(row.rounds_joined),
      inCurrentBatch: row.in_current_batch === true,
    })),
  });
};

function linkStatus(row: {
  revoked_at: Date | null;
  live_invites: string;
  link_last_used: Date | null;
}): 'revoked' | 'never-used' | 'active' | 'no-link' {
  if (row.revoked_at) return 'revoked';
  if (Number(row.live_invites) === 0) return 'no-link';
  return row.link_last_used ? 'active' : 'never-used';
}

/**
 * POST /api/admin/people — add a counselor and mint their link.
 *
 * The raw token is returned exactly once and never stored. Losing it means
 * reissuing, which is cheap; being able to recover it would mean the database
 * held a working credential for every reviewer.
 */
export const createPerson: Handler = async (request) => {
  const session = await requireOwner(request);
  const body = requireObject(request.body, 'a JSON object with an email and a name');
  const email = requireString(body.email, 'email').trim().toLowerCase();
  const displayName = requireString(body.displayName, 'displayName').trim();
  const credentials =
    typeof body.credentials === 'string' && body.credentials.trim() !== ''
      ? body.credentials.trim()
      : null;

  if (!email.includes('@') || email.startsWith('@')) {
    throw badRequest('BAD_EMAIL', 'That does not look like an email address.');
  }

  return transaction(async (client) => {
    const existing = await client.query<{ id: string }>('select id from people where email = $1', [
      email,
    ]);

    let personId: string;
    if (existing.rowCount! > 0) {
      // Re-adding someone is how a returning counselor joins a later batch.
      personId = existing.rows[0]!.id;
      await client.query(
        `update people set display_name = $2, credentials = $3, revoked_at = null where id = $1`,
        [personId, displayName, credentials],
      );
    } else {
      const created = await client.query<{ id: string }>(
        `insert into people (email, display_name, credentials) values ($1,$2,$3) returning id`,
        [email, displayName, credentials],
      );
      personId = created.rows[0]!.id;
    }

    const live = await client.query('select 1 from invites where person_id = $1 and revoked_at is null', [
      personId,
    ]);

    let token: string | null = null;
    if (live.rowCount === 0) {
      const minted = mintInviteToken();
      await client.query(
        `insert into invites (person_id, token_prefix, token_hash, created_by) values ($1,$2,$3,$4)`,
        [personId, minted.prefix, minted.hash, session.person.id],
      );
      token = minted.token;
    }

    // Enrol them in the open batch if there is one.
    const round = await client.query<{ id: string }>(`select id from rounds where status = 'open'`);
    if (round.rowCount! > 0) {
      await client.query(
        `insert into round_participants (round_id, person_id) values ($1,$2) on conflict do nothing`,
        [round.rows[0]!.id, personId],
      );
    }

    return json({
      person: { id: personId, email, displayName, credentials },
      // Null when they already had a live link — reissue to replace it.
      token,
      enrolledInRound: round.rows[0]?.id ?? null,
    });
  });
};

/** POST /api/admin/people/:id/revoke — kill the link, keep the work. */
export const revokePerson: Handler = async (request) => {
  await requireOwner(request);
  const personId = idFrom(request.path, '/api/admin/people/', '/revoke');
  await transaction(async (client) => {
    await client.query('update people set revoked_at = now() where id = $1', [personId]);
    await client.query(
      'update invites set revoked_at = now() where person_id = $1 and revoked_at is null',
      [personId],
    );
  });
  // Their verdicts stay: the owner paid for that work and still needs it.
  return json({ personId, revoked: true });
};

/** POST /api/admin/people/:id/reissue — revoke and mint a fresh link. */
export const reissueInvite: Handler = async (request) => {
  const session = await requireOwner(request);
  const personId = idFrom(request.path, '/api/admin/people/', '/reissue');

  return transaction(async (client) => {
    const person = await client.query('select 1 from people where id = $1', [personId]);
    if (person.rowCount === 0) throw notFound('No such person.');

    await client.query(
      'update invites set revoked_at = now() where person_id = $1 and revoked_at is null',
      [personId],
    );
    await client.query('update people set revoked_at = null where id = $1', [personId]);

    const minted = mintInviteToken();
    await client.query(
      `insert into invites (person_id, token_prefix, token_hash, created_by) values ($1,$2,$3,$4)`,
      [personId, minted.prefix, minted.hash, session.person.id],
    );
    return json({ personId, token: minted.token });
  });
};

function idFrom(path: string, prefix: string, suffix: string): string {
  const id = path.slice(prefix.length, path.length - suffix.length);
  if (!id) throw badRequest('BAD_ID', 'Missing id.');
  return decodeURIComponent(id);
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/** POST /api/admin/round/participants — set who is in the current batch. */
export const setParticipants: Handler = async (request) => {
  await requireOwner(request);
  const round = await openRound();
  const body = requireObject(request.body, 'a JSON object with "personIds"');
  const ids = Array.isArray(body.personIds) ? (body.personIds as string[]) : null;
  if (!ids) throw badRequest('BAD_FIELD', '"personIds" must be an array.');

  return transaction(async (client) => {
    for (const personId of ids) {
      await client.query(
        `insert into round_participants (round_id, person_id) values ($1,$2) on conflict do nothing`,
        [round.id, personId],
      );
    }
    // Removing is deliberately not offered here: a participant with verdicts
    // cannot be un-enrolled without deleting their work (the FK enforces it),
    // and silently deleting a clinician's judgments is never the right default.
    return json({ roundId: round.id, enrolled: ids.length });
  });
};

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** GET /api/admin/progress — the live batch dashboard. */
export const progress: Handler = async (request) => {
  await requireOwner(request);
  const round = await openRound();

  const dataset = await db().query<{ scenario_ids: { input: string[]; output: string[] } }>(
    `select d.scenario_ids from rounds r join datasets d on d.id = r.dataset_id where r.id = $1`,
    [round.id],
  );
  const ids = dataset.rows[0]?.scenario_ids ?? { input: [], output: [] };
  const totals = { input: ids.input.length, output: ids.output.length };

  const perPerson = await db().query(
    `select p.id, p.display_name, p.credentials, p.role, p.last_seen_at, p.revoked_at,
            count(*) filter (where r.file_kind = 'input')  as done_input,
            count(*) filter (where r.file_kind = 'output') as done_output,
            count(*) filter (where r.label_kind = 'change') as changed,
            count(*) filter (where r.hard_case) as hard_cases,
            max(r.reviewed_at) as last_reviewed_at,
            (select count(*) from proposals pr
              where pr.round_id = $1 and pr.author_id = p.id and pr.status = 'draft') as drafts,
            (select count(*) from proposals pr
              where pr.round_id = $1 and pr.author_id = p.id and pr.status = 'submitted') as submitted
       from round_participants rp
       join people p on p.id = rp.person_id
       left join reviews r on r.round_id = rp.round_id and r.person_id = p.id
      where rp.round_id = $1
      group by p.id
      order by p.display_name`,
    [round.id],
  );

  // distinctLabels > 1 is a cheap server-side proxy for contested. The
  // authoritative version is still contestedIds() in the browser, which knows
  // about resolutions and the canon's own label.
  const perScenario = await db().query(
    `select r.scenario_id, r.file_kind,
            count(*) as reviewer_count,
            count(distinct coalesce(r.label_verdict ->> 'proposed', '=agree')) as distinct_labels,
            count(*) filter (where r.hard_case) as hard_case_count
       from reviews r
      where r.round_id = $1
      group by r.scenario_id, r.file_kind
      having count(*) > 1
      order by distinct_labels desc, r.scenario_id`,
    [round.id],
  );

  const unresolved = await db().query<{ n: string }>(
    `select count(*) as n from (
       select r.scenario_id, r.person_id from reviews r
        where r.round_id = $1 and r.label_kind = 'change'
          and not exists (
            select 1 from resolutions res
             where res.round_id = r.round_id and res.scenario_id = r.scenario_id
               and res.person_id = r.person_id and res.concern = 'label')
     ) t`,
    [round.id],
  );

  return json({
    round: { id: round.id, label: round.label },
    totals,
    reviewers: perPerson.rows.map((row) => ({
      personId: row.id,
      displayName: row.display_name,
      credentials: row.credentials,
      role: row.role,
      revoked: row.revoked_at !== null,
      lastSeenAt: row.last_seen_at,
      done: { input: Number(row.done_input), output: Number(row.done_output) },
      changed: Number(row.changed),
      hardCases: Number(row.hard_cases),
      lastReviewedAt: row.last_reviewed_at,
      proposals: { draft: Number(row.drafts), submitted: Number(row.submitted) },
    })),
    perScenario: perScenario.rows.map((row) => ({
      scenarioId: row.scenario_id,
      fileKind: row.file_kind,
      reviewerCount: Number(row.reviewer_count),
      distinctLabels: Number(row.distinct_labels),
      hardCaseCount: Number(row.hard_case_count),
    })),
    unresolvedContested: Number(unresolved.rows[0]?.n ?? 0),
    serverTime: new Date().toISOString(),
  });
};

// ---------------------------------------------------------------------------
// Dataset and the batch cycle
// ---------------------------------------------------------------------------

/** POST /api/admin/dataset — attach a scenario set to the open batch. */
export const uploadDataset: Handler = async (request) => {
  const session = await requireOwner(request);
  const round = await openRound();
  const body = requireObject(request.body, 'a JSON object with the two YAML files');

  const inputYaml = requireString(body.inputYaml, 'inputYaml');
  const outputYaml = requireString(body.outputYaml, 'outputYaml');
  const fileHash = requireString(body.fileHash, 'fileHash');
  const scenarioIds = requireObject(body.scenarioIds, 'scenarioIds');
  const sha256 = sha256Hex(inputYaml + outputYaml);

  return transaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      'select id from datasets where round_id = $1 and sha256 = $2',
      [round.id, sha256],
    );
    const datasetId =
      existing.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `insert into datasets (round_id, label, input_yaml, output_yaml, file_hash, sha256,
                                 scenario_ids, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning id`,
          [
            round.id,
            typeof body.label === 'string' ? body.label : '',
            inputYaml,
            outputYaml,
            fileHash,
            sha256,
            JSON.stringify(scenarioIds),
            session.person.id,
          ],
        )
      ).rows[0]!.id;

    await client.query('update rounds set dataset_id = $1 where id = $2', [datasetId, round.id]);
    return json({ datasetId, sha256, roundId: round.id });
  });
};

/**
 * POST /api/admin/round/promote — the batch cycle, in one transaction.
 *
 * The merge itself runs CLIENT-side: the owner's browser calls
 * exportMergedYaml and posts the resulting bytes. The server archives them,
 * makes them the next batch's canon, and closes the current batch. It never
 * merges anything, which is what keeps §3 true.
 */
export const promoteRound: Handler = async (request) => {
  const session = await requireOwner(request);
  const current = await openRound();
  const body = requireObject(request.body, 'a JSON object with the merged YAML');

  const inputYaml = requireString(body.inputYaml, 'inputYaml');
  const outputYaml = requireString(body.outputYaml, 'outputYaml');
  const fileHash = requireString(body.fileHash, 'fileHash');
  const nextLabel = requireString(body.nextLabel, 'nextLabel');
  const scenarioIds = requireObject(body.scenarioIds, 'scenarioIds');
  const confirm = typeof body.confirm === 'string' ? body.confirm : '';

  // Typing the batch label is the confirmation. Closing a batch is not
  // reversible from the UI, and a mis-click would end everyone's session.
  if (confirm !== current.label) {
    throw badRequest(
      'CONFIRM_MISMATCH',
      `Type the current batch name ("${current.label}") to confirm.`,
    );
  }

  const sha256 = sha256Hex(inputYaml + outputYaml);
  const counts = {
    input: Array.isArray((scenarioIds as { input?: unknown }).input)
      ? ((scenarioIds as { input: string[] }).input).length
      : 0,
    output: Array.isArray((scenarioIds as { output?: unknown }).output)
      ? ((scenarioIds as { output: string[] }).output).length
      : 0,
  };

  return transaction(async (client) => {
    // 1. Archive the exact bytes, so an eval run traces to a canon.
    for (const [kind, yaml, count] of [
      ['input', inputYaml, counts.input],
      ['output', outputYaml, counts.output],
    ] as const) {
      await client.query(
        `insert into exports (round_id, kind, yaml, sha256, scenario_count, exported_by, note)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          current.id,
          kind,
          yaml,
          sha256Hex(yaml),
          count,
          session.person.id,
          typeof body.note === 'string' ? body.note : null,
        ],
      );
    }

    // 2. Close the current batch BEFORE opening the next: rounds_one_open
    //    allows exactly one, and the constraint is the point.
    await client.query(`update rounds set status = 'closed', closed_at = now() where id = $1`, [
      current.id,
    ]);

    // 3. Open the next, recording where its canon came from.
    const next = await client.query<{ id: string; label: string }>(
      `insert into rounds (label, promoted_from_round_id) values ($1,$2) returning id, label`,
      [nextLabel, current.id],
    );
    const nextId = next.rows[0]!.id;

    // 4. The promoted bytes become its dataset.
    const dataset = await client.query<{ id: string }>(
      `insert into datasets (round_id, label, input_yaml, output_yaml, file_hash, sha256,
                             scenario_ids, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning id`,
      [
        nextId,
        `Promoted from ${current.label}`,
        inputYaml,
        outputYaml,
        fileHash,
        sha256,
        JSON.stringify(scenarioIds),
        session.person.id,
      ],
    );
    await client.query('update rounds set dataset_id = $1 where id = $2', [
      dataset.rows[0]!.id,
      nextId,
    ]);

    // The owner is deliberately NOT enrolled: they administer and do not
    // review (§6.2). requireActiveSession admits them on role, not enrollment,
    // so they keep full access to the new batch without becoming a reviewer in
    // it. Counselors are enrolled explicitly, when Joel is ready.

    return json({
      closed: { id: current.id, label: current.label },
      opened: { id: nextId, label: next.rows[0]!.label, datasetId: dataset.rows[0]!.id },
      archivedSha256: sha256,
    });
  });
};

/** GET /api/admin/exports — archived merged YAML, for eval provenance. */
export const listExports: Handler = async (request) => {
  await requireOwner(request);
  const result = await db().query(
    `select e.id, e.round_id, r.label as round_label, e.kind, e.sha256,
            e.scenario_count, e.exported_at, e.note, length(e.yaml) as bytes
       from exports e join rounds r on r.id = e.round_id
      order by e.exported_at desc limit 100`,
  );
  return json({ exports: result.rows });
};

/** GET /api/admin/exports/:id — the archived bytes themselves. */
export const getExport: Handler = async (request) => {
  await requireOwner(request);
  const id = decodeURIComponent(request.path.slice('/api/admin/exports/'.length));
  const result = await db().query<{ yaml: string; kind: string; sha256: string }>(
    'select yaml, kind, sha256 from exports where id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('No such export.');
  return json({ kind: row.kind, sha256: row.sha256, yaml: row.yaml });
};

// ---------------------------------------------------------------------------
// Overlay import — the escape hatch and the migration path
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/overlays/import — take a .review.json into the database.
 *
 * Used to migrate pre-backend work and to rescue a counselor whose sync never
 * worked. Refuses an overlay already baked into the active canon: re-merging
 * one would duplicate every reviewer_note, because merge.ts appends notes
 * unconditionally while appendStamp dedupes stamps.
 */
export const importOverlayFile: Handler = async (request) => {
  await requireOwner(request);
  const round = await openRound();
  const body = requireObject(request.body, 'a review file');

  const file = body as unknown as ReviewFile;
  if (file.format !== 'srs.review') {
    throw badRequest('NOT_A_REVIEW_FILE', "That isn't a review file. Look for one ending in .review.json.");
  }
  if (file.version !== REVIEW_FILE_VERSION) {
    throw badRequest('VERSION', `That review file is version ${file.version}; this app reads ${REVIEW_FILE_VERSION}.`);
  }
  const overlay = file.overlay;
  if (!overlay?.reviewer?.id) throw badRequest('NO_REVIEWER', 'That review file has no reviewer.');

  const email =
    typeof body.email === 'string' && body.email.includes('@')
      ? body.email.trim().toLowerCase()
      : null;

  return transaction(async (client) => {
    // Map the file's reviewer onto a person: by email if given, else by the
    // legacy slug that pre-backend ids used.
    let person = (
      await client.query<DbPersonRow>(
        `select ${PERSON_COLUMNS} from people where ($1::text is not null and email = $1)
            or legacy_slug = $2 or id::text = $2`,
        [email, overlay.reviewer.id],
      )
    ).rows[0];

    if (!person) {
      if (!email) {
        throw badRequest(
          'NEED_EMAIL',
          `No counselor matches "${overlay.reviewer.displayName}". Send an "email" alongside the file to create or link them.`,
        );
      }
      person = (
        await client.query<DbPersonRow>(
          `insert into people (email, display_name, credentials, legacy_slug)
           values ($1,$2,$3,$4) returning ${PERSON_COLUMNS}`,
          [email, overlay.reviewer.displayName, overlay.reviewer.credentials ?? null, overlay.reviewer.id],
        )
      ).rows[0]!;
    }

    await client.query(
      `insert into round_participants (round_id, person_id) values ($1,$2) on conflict do nothing`,
      [round.id, person.id],
    );

    const dataset = await client.query<{ scenario_ids: { input: string[]; output: string[] } }>(
      `select d.scenario_ids from rounds r join datasets d on d.id = r.dataset_id where r.id = $1`,
      [round.id],
    );
    const ids = dataset.rows[0]?.scenario_ids ?? { input: [], output: [] };
    const fileKinds = new Map<string, 'input' | 'output'>();
    for (const id of ids.input) fileKinds.set(id, 'input');
    for (const id of ids.output) fileKinds.set(id, 'output');

    // Merge against what is already stored rather than overwriting, using the
    // same comparator the sync path uses.
    const stored = await client.query<DbReviewRow>(
      `select round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
              label_verdict, rationale_verdict, realism_verdict,
              hard_case, comment, proposed_text_edits
         from reviews where round_id = $1 and person_id = $2`,
      [round.id, person.id],
    );
    const storedProposals = await client.query<DbProposalRow>(
      `select round_id, author_id, temp_id, target_file, status, scenario, assigned_id, accepted
         from proposals where round_id = $1 and author_id = $2`,
      [round.id, person.id],
    );

    const incoming = {
      ...overlay,
      reviewer: { ...overlay.reviewer, id: person.id },
      reviews: Object.fromEntries(
        Object.entries(overlay.reviews ?? {}).map(([id, review]) => [
          id,
          { ...review, reviewerId: person.id },
        ]),
      ),
    };
    const merged = mergeOverlayInto(
      toOverlay(person, stored.rows, storedProposals.rows),
      incoming,
    );

    let written = 0;
    const skipped: string[] = [];
    for (const review of Object.values(merged.reviews)) {
      const fileKind = fileKinds.get(review.scenarioId);
      if (!fileKind) {
        skipped.push(review.scenarioId);
        continue;
      }
      await client.query(
        `insert into reviews (round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
                              reviewed_at, label_verdict, rationale_verdict, realism_verdict,
                              hard_case, comment, proposed_text_edits)
         values ($1,$2,$3,$4,$5::text,$5::timestamptz,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb)
         on conflict (round_id, person_id, scenario_id) do update set
           reviewed_at_iso = excluded.reviewed_at_iso,
           reviewed_at = excluded.reviewed_at,
           label_verdict = excluded.label_verdict,
           rationale_verdict = excluded.rationale_verdict,
           realism_verdict = excluded.realism_verdict,
           hard_case = excluded.hard_case,
           comment = excluded.comment,
           proposed_text_edits = excluded.proposed_text_edits,
           updated_at = now()
         where excluded.reviewed_at_iso >= reviews.reviewed_at_iso`,
        [
          round.id,
          person.id,
          review.scenarioId,
          fileKind,
          review.reviewedAt,
          JSON.stringify(review.labelVerdict),
          JSON.stringify(review.rationaleVerdict),
          JSON.stringify(review.realismVerdict),
          review.hardCase,
          review.comment ?? null,
          review.proposedTextEdits ? JSON.stringify(review.proposedTextEdits) : null,
        ],
      );
      written += 1;
    }

    for (const proposal of merged.proposals) {
      await client.query(
        `insert into proposals (round_id, author_id, temp_id, target_file, status, scenario)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (round_id, author_id, temp_id) do update set
           status = excluded.status, scenario = excluded.scenario, updated_at = now()`,
        [
          round.id,
          person.id,
          proposal.tempId,
          proposal.targetFile,
          proposal.status,
          JSON.stringify(proposal.scenario),
        ],
      );
    }

    return json({
      person: { id: person.id, displayName: person.display_name, email: person.email },
      imported: written,
      proposals: merged.proposals.length,
      // Named rather than dropped silently: these are usually a sign the file
      // belongs to a different scenario set.
      skipped,
    });
  });
};

/** GET /api/admin/export/overlays — every overlay as review files, archival. */
export const exportOverlays: Handler = async (request) => {
  await requireOwner(request);
  const round = await openRound();

  const people = await db().query<DbPersonRow>(
    `select distinct p.id, p.email, p.display_name, p.credentials, p.role
       from round_participants rp join people p on p.id = rp.person_id
      where rp.round_id = $1 order by p.display_name`,
    [round.id],
  );

  const files: ReviewFile[] = [];
  for (const person of people.rows) {
    const reviews = await db().query<DbReviewRow>(
      `select round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
              label_verdict, rationale_verdict, realism_verdict,
              hard_case, comment, proposed_text_edits
         from reviews where round_id = $1 and person_id = $2 order by scenario_id`,
      [round.id, person.id],
    );
    const proposals = await db().query<DbProposalRow>(
      `select round_id, author_id, temp_id, target_file, status, scenario, assigned_id, accepted
         from proposals where round_id = $1 and author_id = $2 order by temp_id`,
      [round.id, person.id],
    );
    if (reviews.rowCount === 0 && proposals.rowCount === 0) continue;

    files.push({
      format: 'srs.review',
      version: REVIEW_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      overlay: toOverlay(person, reviews.rows, proposals.rows),
    });
  }

  return json({ round: round.label, files });
};

/** POST /api/admin/round — open the first batch, or close one by hand. */
export const manageRound: Handler = async (request) => {
  await requireOwner(request);
  const body = requireObject(request.body, 'a JSON object with an "action"');
  const action = requireString(body.action, 'action');

  if (action === 'open') {
    const label = requireString(body.label, 'label');
    try {
      const created = await db().query<{ id: string; label: string }>(
        `insert into rounds (label) values ($1) returning id, label`,
        [label],
      );
      return json({ round: created.rows[0] });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'rounds_one_open') {
        throw conflict('ALREADY_OPEN', 'A batch is already open. Close it first.');
      }
      throw error;
    }
  }

  if (action === 'close') {
    const round = await openRound();
    if (body.confirm !== round.label) {
      throw badRequest('CONFIRM_MISMATCH', `Type "${round.label}" to confirm.`);
    }
    await db().query(`update rounds set status = 'closed', closed_at = now() where id = $1`, [
      round.id,
    ]);
    return json({ closed: round });
  }

  throw badRequest('BAD_ACTION', '"action" must be "open" or "close".');
};

export const noContentOk: Handler = async () => noContent();
