# Rung — clinician review app for the Handrail safety eval suite

## Source of truth
- RUNG_SPEC.md is the authoritative spec. When in doubt, re-read it.
  Do not improvise features it doesn't call for.
- The YAML scenario files are canonical data. NEVER modify
  input_tier_scenarios.yaml or output_behavior_scenarios.yaml —
  the app reads them; only the export path writes merged copies.

## What this app is used for (§1.1)
A repeating batch loop, not a single review pass: enrol 3–8 counselors →
they review → owner resolves → promote the merged YAML to the next
batch's canon → run evals → repeat. Identity is global and keyed on
email, so a returning counselor reuses the link they already have.
Participation is per-round. Exactly one batch is open at a time.

## Non-negotiables (spec §-refs)
- ReviewOverlay architecture (§3): verdicts are an overlay keyed by
  scenario id. Imported scenarios stay immutable in memory. No exceptions.
- **The database stores only ReviewOverlay.** It never holds a merged
  result, never parses YAML, and no column means "the canon says X".
  `api/**` must not import from `src/lib/**` — enforced by
  scripts/check-import-boundary.mjs, which runs in `npm test`. If you
  need something from there, move it to `shared/`.
- **Merging happens only at export time, in the browser.** Including
  promotion: the client merges and posts the bytes; the server archives
  them. There must be no server code path that could merge.
- **The network is never on the Save & next path** (AC-2). `saveReview`
  writes to the store and a local outbox, synchronously, and returns.
  Anything that makes it await is a regression.
- Blind review (§6.1): a reviewer sees another's verdict for scenario X
  only after saving their own for X. Enforced server-side in
  api/src/blind.ts — one WHERE clause, one place. Subsetting overlays is
  allowed; combining them is not.
- **The owner administers and never reviews** (§6.2). Joel is not a
  counselor. He sees every verdict, so his own could not be independent
  and would corrupt the agreement number. Enforced three ways: he has no
  `round_participants` row (and reviews/proposals FK to it, so the DB
  refuses), `refuseIfOwner` returns 403, and the UI shows no verdict bar.
  Never enrol the owner as a participant — not in seed, not in promotion.
- Round-trip fidelity (§4.3, AC-5/6/11): export diffs must be surgical,
  and DB-sourced exports byte-identical to local ones.
- Contested changes never silently rewrite expected_tier/expected_result.
- No gamification, no confetti, no celebratory animation, no sounds (§7).
- No per-reviewer timing or throughput metrics (§2) — one step from
  scoring clinicians.
- Design tokens in §8 are exact — hex values and fonts are not suggestions.

## Database credentials
- `DATABASE_URL` is the **least-privilege** `rung_app` role: CRUD only, no DDL.
  The API, the seed, the backups, and every test use it. Keeping the
  conventional name for the safe URL means the safe thing is the default.
- `ADMIN_DATABASE_URL` is admin, used only by hand-run operator scripts on the
  allowlist in scripts/check-db-privileges.mjs. `api/`, `src/` and `shared/`
  must never reference it — enforced in `npm test`.
- `db:create` derives the app role's name and password from `DATABASE_URL`, so
  there is one copy of that credential. It refuses to run if `DATABASE_URL`
  names the same account as `ADMIN_DATABASE_URL` — that bug already shipped once.
- The server is shared with other databases. `rung_app` has no CONNECT on
  `elevenlabs_music` (revoked from PUBLIC), which means any new role there needs
  an explicit grant. `npm run db:verify-role` and `node db/check-blast-radius.mjs`
  check both halves: what the app role can do, and what it can reach.

## Storage rules that will bite you
- `purgeOldVersions()` in src/store/persist.ts deletes every `srs:*` key
  not under the current version prefix, at module load. Anything that must
  survive a version bump goes in `NEVER_PURGE`. The outbox is in there
  because losing unsent verdicts is the worst failure this app has.
- Postgres will not infer a type for a parameter used as both `text` and
  `timestamptz`, or for one a statement never references. Cast explicitly
  and give each query branch its own parameter list.

## Stack decisions (already made — don't relitigate)
Vite + React 18 + TS, Tailwind with CSS-variable tokens, js-yaml,
Zustand, hash routing only.
Backend: Postgres on Azure via a small same-origin Node API in `api/`,
raw `pg`, plain `.sql` migrations, no ORM. Identity is a per-counselor
invite token in the URL fragment; no passwords, no SSO, no email sending.

(v1 said "no backend, no auth". That was superseded — see §2's
Superseded note for why.)

## Testing
- `npm test` — unit + the import-boundary check. No network needed.
- `npm run test:db` — integration against the real database.
- `npm run e2e` — HTTP end-to-end; needs `npm run api:dev`.
- `npm run e2e:browser` — Playwright; needs `api:dev` and `dev`.
- A test that can pass vacuously is worse than none. Assert the write
  landed before asserting what is hidden.

## Conventions
- TypeScript strict; types in §4 are the contract, extend don't rename
- Roles render as "Client"/"Coach" in UI, never user/assistant
- Sentence case in all UI copy; buttons name their exact action
- Identity never appears in a response: `toReviewer` drops the email
