// AC-12: the blind rule, against a real database.
//
// The load-bearing assertions here run against the SERIALISED response text,
// not a parsed object. A structural check ("overlays[1].reviews has no key
// s2") passes even when the same reasoning leaks through a field nobody
// thought to look at. Searching the bytes for the other reviewer's actual
// words is the only check that keeps working as the response shape grows.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadOverlayView } from './blind';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
afterAll(async () => {
  await client.end();
});

// Distinctive strings: if any of these appears in a response, we know exactly
// which secret leaked and to whom.
const SECRET = {
  bLabel: 'BRAVO-SAID-PAUSE-AND-ROUTE',
  bRationale: 'BRAVO-THINKS-THE-RATIONALE-IS-FLAWED',
  bComment: 'BRAVO-PRIVATE-COMMENT',
  bProposal: 'BRAVO-AUTHORED-SCENARIO',
  cLabel: 'CHARLIE-SAID-CRISIS-PROTOCOL',
};

type Ctx = { roundId: string; a: string; b: string; c: string; owner: string };

async function person(name: string, role: 'reviewer' | 'owner' = 'reviewer') {
  const row = await client.query(
    `insert into people (email, display_name, role) values ($1, $2, $3) returning id`,
    // Lowercased because people_email_check enforces it — the display name is
    // capitalised and would otherwise be rejected.
    [`${name.toLowerCase()}-${randomUUID()}@example.com`, name, role],
  );
  return row.rows[0].id as string;
}

async function saveReview(
  roundId: string,
  personId: string,
  scenarioId: string,
  because: string,
  extras: { comment?: string } = {},
) {
  await client.query(
    `insert into reviews (round_id, person_id, scenario_id, file_kind,
                          reviewed_at_iso, reviewed_at,
                          label_verdict, rationale_verdict, realism_verdict, comment)
     values ($1,$2,$3,'input',$4::text,$4::timestamptz,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
    [
      roundId,
      personId,
      scenarioId,
      '2026-08-06T12:00:00.000Z',
      JSON.stringify({ kind: 'change', proposed: 'pause_and_route', because }),
      JSON.stringify({ kind: 'sound' }),
      JSON.stringify({ kind: 'realistic' }),
      extras.comment ?? null,
    ],
  );
}

/**
 * Alpha has reviewed s1 only. Bravo has reviewed s1 and s2. Charlie has
 * reviewed s2 only. So Alpha should see Bravo's s1 and nothing else.
 */
async function scenario(): Promise<Ctx> {
  const round = await client.query(
    `insert into rounds (label, status) values ('blind test', 'closed') returning id`,
  );
  const roundId = round.rows[0].id as string;

  const a = await person('Alpha');
  const b = await person('Bravo');
  const c = await person('Charlie');
  const owner = await person('Olive', 'owner');

  for (const id of [a, b, c, owner]) {
    await client.query(
      `insert into round_participants (round_id, person_id) values ($1, $2)`,
      [roundId, id],
    );
  }

  await saveReview(roundId, a, 's1', 'ALPHA-OWN-REASONING');
  await saveReview(roundId, b, 's1', SECRET.bLabel, { comment: SECRET.bComment });
  await client.query(
    `update reviews set rationale_verdict = $3::jsonb
      where round_id = $1 and person_id = $2 and scenario_id = 's1'`,
    [roundId, b, JSON.stringify({ kind: 'flawed', because: SECRET.bRationale })],
  );
  await saveReview(roundId, b, 's2', 'BRAVO-ON-S2-WHICH-ALPHA-HAS-NOT-SEEN');
  await saveReview(roundId, c, 's2', SECRET.cLabel);

  await client.query(
    `insert into proposals (round_id, author_id, temp_id, target_file, status, scenario)
     values ($1, $2, 'new-bravo', 'input', 'submitted', $3::jsonb)`,
    [roundId, b, JSON.stringify({ description: SECRET.bProposal })],
  );

  return { roundId, a, b, c, owner };
}

const view = (ctx: Ctx, viewerId: string, isOwner = false) =>
  loadOverlayView({ roundId: ctx.roundId, viewerId, isOwner }, client);

beforeEach(async () => {
  await client.query('begin');
  return async () => {
    await client.query('rollback');
  };
});

describe('AC-12 — nothing a reviewer has not earned appears in the bytes', () => {
  it("withholds every trace of a scenario the viewer has not answered", async () => {
    const ctx = await scenario();
    const body = JSON.stringify(await view(ctx, ctx.a));

    // Alpha answered s1, so Bravo's s1 verdict is legitimately visible.
    expect(body).toContain(SECRET.bLabel);

    // Alpha never answered s2. Nothing about s2 may appear, from anyone.
    expect(body).not.toContain(SECRET.cLabel);
    expect(body).not.toContain('BRAVO-ON-S2-WHICH-ALPHA-HAS-NOT-SEEN');
    expect(body).not.toContain('"s2"');
    expect(body).not.toContain('Charlie');
  });

  it("withholds another reviewer's authored scenarios", async () => {
    const ctx = await scenario();
    const body = JSON.stringify(await view(ctx, ctx.a));
    expect(body).not.toContain(SECRET.bProposal);
  });

  it('never emits an email, whoever is asking', async () => {
    const ctx = await scenario();
    for (const [viewer, isOwner] of [
      [ctx.a, false],
      [ctx.owner, true],
    ] as const) {
      expect(JSON.stringify(await view(ctx, viewer, isOwner))).not.toContain('@example.com');
    }
  });

  it('gives the owner everything, because resolving cannot be done blind', async () => {
    const ctx = await scenario();
    const body = JSON.stringify(await view(ctx, ctx.owner, true));
    for (const secret of Object.values(SECRET)) expect(body).toContain(secret);
  });
});

describe('the visibility set is per scenario, not all-or-nothing', () => {
  it("returns the viewer's own overlay complete", async () => {
    const ctx = await scenario();
    const { overlays } = await view(ctx, ctx.a);
    const mine = overlays.find((o) => o.reviewer.id === ctx.a);
    expect(Object.keys(mine!.reviews)).toEqual(['s1']);
  });

  it("subsets another reviewer's reviews map rather than dropping them", async () => {
    const ctx = await scenario();
    const { overlays } = await view(ctx, ctx.a);
    const bravo = overlays.find((o) => o.reviewer.id === ctx.b);
    // Bravo reviewed s1 and s2; Alpha may see only the s1 half.
    expect(Object.keys(bravo!.reviews)).toEqual(['s1']);
    expect(bravo!.proposals).toEqual([]);
  });

  it('omits a reviewer entirely when nothing of theirs is visible', async () => {
    const ctx = await scenario();
    const { overlays } = await view(ctx, ctx.a);
    // Charlie only answered s2, which Alpha has not reached.
    expect(overlays.map((o) => o.reviewer.displayName)).toEqual(['Alpha', 'Bravo']);
  });

  it('unlocks the rest the moment the viewer answers', async () => {
    const ctx = await scenario();
    expect(JSON.stringify(await view(ctx, ctx.a))).not.toContain(SECRET.cLabel);

    await saveReview(ctx.roundId, ctx.a, 's2', 'ALPHA-NOW-ANSWERED-S2');

    const after = JSON.stringify(await view(ctx, ctx.a));
    expect(after).toContain(SECRET.cLabel);
    expect(after).toContain('Charlie');
  });

  it('a reviewer who has answered nothing sees only themselves', async () => {
    const ctx = await scenario();
    const newcomer = await person('Dana');
    await client.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
      ctx.roundId,
      newcomer,
    ]);

    const { overlays } = await view(ctx, newcomer);
    expect(overlays).toEqual([]); // no rows of their own yet, and nothing earned
  });
});

describe('resolutions follow the same rule', () => {
  it("hides a resolution for a scenario the viewer has not answered", async () => {
    // A resolution's existence reveals that somebody contested that scenario.
    const ctx = await scenario();
    for (const scenarioId of ['s1', 's2']) {
      await client.query(
        `insert into resolutions (round_id, scenario_id, person_id, concern, decision, resolved_at_iso)
         values ($1, $2, $3, 'label', 'keep', '2026-08-06T16:00:00.000Z')`,
        [ctx.roundId, scenarioId, ctx.b],
      );
    }

    const asAlpha = await view(ctx, ctx.a);
    expect(Object.keys(asAlpha.resolutions).map((k) => k.split('::')[0])).toEqual(['s1']);

    const asOwner = await view(ctx, ctx.owner, true);
    expect(Object.keys(asOwner.resolutions)).toHaveLength(2);
  });
});

describe('revoked participants', () => {
  it("hides a revoked person's verdicts from reviewers but keeps them for the owner", async () => {
    const ctx = await scenario();
    await client.query('update people set revoked_at = now() where id = $1', [ctx.b]);

    expect(JSON.stringify(await view(ctx, ctx.a))).not.toContain(SECRET.bLabel);
    // Their work is still data the owner paid for.
    expect(JSON.stringify(await view(ctx, ctx.owner, true))).toContain(SECRET.bLabel);
  });
});

describe('delta sync', () => {
  it('respects `since` without widening what is visible', async () => {
    const ctx = await scenario();
    const future = new Date(Date.now() + 60_000).toISOString();
    const { overlays } = await loadOverlayView(
      { roundId: ctx.roundId, viewerId: ctx.a, isOwner: false, since: future },
      client,
    );
    expect(overlays).toEqual([]);
  });
});
