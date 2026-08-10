-- Rung backend, initial schema.
--
-- The one rule this schema exists to serve: the database stores a
-- ReviewOverlay (shared/review.ts) decomposed into rows and nothing else about
-- review semantics. It never holds a merged result, never parses YAML, and no
-- column here means "the canon says X". Merging happens only at export time,
-- in the browser (spec §3).
--
-- Normalisation follows the server's own logic and stops there:
--   * rows per (round, person, scenario), because the blind filter, the
--     dashboard, and delta sync all need them;
--   * the TypeScript discriminated unions stay jsonb, verbatim. Re-encoding
--     Verdict<T> into columns is how a transport turns into a second model.
--
-- gen_random_uuid() is core in PG13+; no pgcrypto needed (server is 17.10).
-- citext is NOT allow-listed on Azure Database for PostgreSQL, so email is
-- plain text held lowercase by a CHECK, with a unique index to match. Same
-- case-insensitive guarantee, no extension dependency, and the constraint
-- makes the normalisation the API must do impossible to forget.

-- ---------------------------------------------------------------------------
-- Identity. GLOBAL: one row per counselor, ever.
--
-- Scoping identity to a round would hand a returning counselor a fresh id
-- every batch, which breaks the recurring loop the app is actually used for.
-- Participation is per-round; identity is not.
-- ---------------------------------------------------------------------------

create table people (
  id            uuid primary key default gen_random_uuid(),  -- replaces slug(displayName)
  email         text not null unique                         -- the durable identity key
                check (email = lower(email) and position('@' in email) > 1),
  display_name  text not null,
  credentials   text,
  role          text not null default 'reviewer'
                check (role in ('reviewer', 'owner')),
  legacy_slug   text unique,                                 -- maps pre-DB slug ids on import
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz                                  -- revokes the person everywhere
);

-- ---------------------------------------------------------------------------
-- Rounds are batches. Strictly sequential: one open round at a time.
-- Also the replacement for the localStorage version-purge reset, which was
-- premised on "every reviewer opens this in their own browser" — false once a
-- server exists.
-- ---------------------------------------------------------------------------

create table rounds (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  status      text not null default 'open'
              check (status in ('open', 'closed', 'archived')),
  dataset_id  uuid,                        -- FK added after datasets exists
  -- Provenance for the loop: which round's export became this round's canon.
  -- Null for the first round.
  promoted_from_round_id uuid references rounds(id),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create unique index rounds_one_open on rounds (status) where status = 'open';

-- ---------------------------------------------------------------------------
-- The canon, as TEXT.
--
-- Export is a line-span patch over these exact bytes (src/lib/yaml/source.ts
-- scans spans, patch.ts splices). A parsed/normalised representation would
-- make AC-5 and AC-6 unachievable. Never decompose these into rows.
-- ---------------------------------------------------------------------------

create table datasets (
  id           uuid primary key default gen_random_uuid(),
  round_id     uuid not null references rounds(id) on delete cascade,
  label        text not null default '',
  input_yaml   text not null,
  output_yaml  text not null,
  file_hash    text not null,   -- client djb2 (persist.ts) — localStorage continuity
  sha256       text not null,   -- server content address; the real identity
  -- {"input": ["routine-001", ...], "output": [...]}. Computed CLIENT-side at
  -- upload and opaque to the server: it lets the dashboard count totals
  -- without the server ever parsing YAML.
  scenario_ids jsonb not null,
  uploaded_by  uuid references people(id),
  created_at   timestamptz not null default now()
);
create unique index on datasets (round_id, sha256);
create index on datasets (round_id, created_at desc);

alter table rounds
  add constraint rounds_dataset_fk foreign key (dataset_id)
  references datasets(id) deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- Per-round enrollment. A counselor in batches 1 and 3 has two rows here and
-- one row in people.
-- ---------------------------------------------------------------------------

create table round_participants (
  round_id     uuid not null references rounds(id) on delete cascade,
  person_id    uuid not null references people(id) on delete cascade,
  joined_at    timestamptz,     -- null until their first load
  completed_at timestamptz,     -- set when they report done
  primary key (round_id, person_id)
);
create index on round_participants (person_id);

-- ---------------------------------------------------------------------------
-- Invite tokens. The raw token is never stored: the prefix indexes the lookup
-- and the sha256 verifies it. 256 bits of entropy wants a fast digest, not a
-- password KDF — same design as a GitHub PAT.
--
-- Attached to the PERSON, not the round, so one link works for every batch
-- that person is enrolled in. Minted once per counselor, reused forever.
-- ---------------------------------------------------------------------------

create table invites (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references people(id) on delete cascade,
  token_prefix text not null,
  token_hash   bytea not null,
  created_at   timestamptz not null default now(),
  created_by   uuid references people(id),
  expires_at   timestamptz,     -- normally null; links are durable
  revoked_at   timestamptz,
  last_used_at timestamptz,
  use_count    integer not null default 0
);
create unique index on invites (token_prefix);
create index on invites (person_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- The overlay, decomposed. This table and `proposals` ARE the ReviewOverlay.
-- ---------------------------------------------------------------------------

create table reviews (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid not null references rounds(id) on delete cascade,
  person_id   uuid not null references people(id) on delete cascade,
  scenario_id text not null,
  file_kind   text not null check (file_kind in ('input', 'output')),

  -- Stored twice on purpose. reviewed_at_iso is the verbatim client string:
  -- merge.ts sorts reviewers with localeCompare on it and stamps.ts slices its
  -- first 10 chars into the YAML, so a reformatted timestamp silently changes
  -- merge precedence and stamp dates. reviewed_at is the server-side cast,
  -- used only for ordering and dashboards.
  reviewed_at_iso text        not null,
  reviewed_at     timestamptz not null,

  label_verdict       jsonb not null,   -- Verdict<TierValue | boolean>
  rationale_verdict   jsonb not null,   -- RationaleVerdict
  realism_verdict     jsonb not null,   -- RealismVerdict
  hard_case           boolean not null default false,
  comment             text,
  proposed_text_edits jsonb,            -- ProposedTextEdits | null

  dataset_id  uuid references datasets(id),   -- which text they judged
  device_id   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Derived, never authoritative: dashboard and blind filter only.
  label_kind text generated always as (label_verdict ->> 'kind') stored,

  constraint reviews_shape check (
        label_verdict     ->> 'kind' in ('agree', 'change')
    and rationale_verdict ->> 'kind' in ('sound', 'flawed')
    and realism_verdict   ->> 'kind' in ('realistic', 'unrealistic')
  ),
  -- A verdict implies enrollment in that round.
  foreign key (round_id, person_id)
    references round_participants (round_id, person_id) on delete cascade,
  unique (round_id, person_id, scenario_id)
);
create index on reviews (round_id, scenario_id);        -- blind filter, dashboard
create index on reviews (round_id, person_id);          -- load one overlay
create index on reviews (round_id, updated_at desc);    -- delta sync

create table proposals (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid not null references rounds(id) on delete cascade,
  author_id   uuid not null references people(id) on delete cascade,
  temp_id     text not null,
  target_file text not null check (target_file in ('input', 'output')),
  status      text not null check (status in ('draft', 'submitted')),
  -- Partial<InputScenario | OutputScenario>, verbatim. This contains
  -- expected_tier, which is NOT a canon write: it is a draft inside the
  -- overlay, exactly as ProposedScenario defines it (§4.2).
  scenario    jsonb not null,
  assigned_id text,      -- owner-only write
  accepted    boolean,   -- owner-only write
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (round_id, author_id)
    references round_participants (round_id, person_id) on delete cascade,
  unique (round_id, author_id, temp_id)
);
-- Fixes "two counselors working offline both get rigidity-042" at the only
-- layer that can enforce it.
create unique index proposals_assigned_id_unique
  on proposals (round_id, target_file, assigned_id) where assigned_id is not null;
create index on proposals (round_id, author_id);

-- ---------------------------------------------------------------------------
-- Owner decisions on contested items (§5.5). Deliberately outside every
-- overlay: resolution is a property of the canon, not of a reviewer, and it is
-- never part of a .review.json.
-- ---------------------------------------------------------------------------

create table resolutions (
  round_id        uuid not null references rounds(id) on delete cascade,
  scenario_id     text not null,
  person_id       uuid not null references people(id) on delete cascade,
  concern         text not null
                  check (concern in ('label', 'rationale', 'realism', 'text')),
  decision        text not null check (decision in ('accept', 'keep', 'manual')),
  -- jsonb, not text: merge.ts compares manualValue with `=== true`. Stored as
  -- text it becomes 'true' and silently stops applying.
  manual_value    jsonb,
  resolved_at_iso text not null,
  resolved_at     timestamptz not null default now(),
  resolved_by     uuid references people(id),
  primary key (round_id, scenario_id, person_id, concern),
  constraint manual_needs_value check (decision <> 'manual' or manual_value is not null)
);

-- ---------------------------------------------------------------------------
-- Provenance for the eval loop. Every merged YAML the owner downloads is
-- archived verbatim, so an eval run traces to exact bytes. Cheap now; needed
-- by batch three, when two eval runs disagree and the question is "which canon
-- produced this?"
--
-- This is an archive of an artifact, never a source of truth. Nothing reads it
-- back into the merge path.
-- ---------------------------------------------------------------------------

create table exports (
  id             uuid primary key default gen_random_uuid(),
  round_id       uuid not null references rounds(id) on delete cascade,
  kind           text not null check (kind in ('input', 'output')),
  yaml           text not null,   -- the exact downloaded bytes
  sha256         text not null,
  scenario_count integer not null,
  exported_by    uuid references people(id),
  exported_at    timestamptz not null default now(),
  note           text             -- e.g. "eval run 2026-08-14"
);
create index on exports (round_id, exported_at desc);
