# Rung — Scenario Review Studio

A browser-based review tool for licensed clinicians validating the safety eval
scenarios behind an exposure-therapy homework coach. Built to
[`_specs/RUNG_SPEC.md`](_specs/RUNG_SPEC.md).

The two YAML files in [`data/`](data/) are the canonical artifacts. This app is
a structured editor and review-capture layer on top of them; it never mutates
them in place, and export writes a copy.

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # unit suites + the api/src/lib import-boundary check
npm run build
```

The UI runs standalone against the embedded dataset. To run it against the
database as well:

```bash
cp .env.example .env    # fill in the connection strings
npm run db:create       # database + least-privilege rung_app role
npm run db:migrate
npm run db:seed         # owner, first batch, canon — prints the owner link once
npm run api:dev         # :7071, proxied from the dev server at /api
```

## How it fits together

```
data/*.yaml ──parse──▶ ScenarioSet (immutable in memory)
                            │
          ReviewOverlay per reviewer (localStorage + Postgres)
                            │
      ┌─────────────────────┴──────────────────────┐
  .review.json                              merged YAML
  (one reviewer, portable)                  (patched original text)
                                                   │
                                          promote to next batch
```

The **overlay** is the load-bearing idea. Verdicts, comments, proposed edits
and authored scenarios are keyed by scenario `id` and stored beside the canon,
never inside it. Merging happens only at export. That is what makes
multi-reviewer support, disagreement views, and clean diffs fall out for free.

**The database does not change that.** It stores a `ReviewOverlay` decomposed
into rows and reassembles the byte-identical object on read — the same shape a
`.review.json` carries. One wire format, two transports. The merge still runs
in the browser at export time, including when promoting a batch: the client
merges and posts the bytes, and the server only archives them. `api/**` cannot
import `src/lib/**`, and `npm test` fails if it does.

| Path | What lives there |
| --- | --- |
| `data/` | The canonical YAML. Read by the app, written only by export. |
| `shared/` | The contract both sides speak: scenario and overlay types, row mappers, the one conflict comparator. |
| `src/types/` | Re-export shims onto `shared/`. |
| `src/lib/yaml/` | Parse, source scanning, line patching, scalar emission. |
| `src/lib/` | Merge rules, stamps, agreement report, export, file I/O. |
| `src/store/` | Zustand store and debounced `localStorage` persistence. |
| `src/sync/` | Outbox, drain loop, pull, session, invite-link routing. |
| `src/components/` | Workspace, rail, stage, verdict bar, panels. |
| `api/src/` | The HTTP layer: auth, blind filter, reads, writes, admin. |
| `db/` | Migrations, the runner, seed, backups, and the e2e harnesses. |

## Sync, and why Save & next never waits

`saveReview` writes to the store and to a local outbox — synchronously — and
returns. Nothing a reviewer does waits on the network. The outbox drains 1.5s
after the last edit, on reconnect, on tab focus, and via `sendBeacon` on close.

The queue is a desired-state map rather than a log: re-saving a scenario
replaces its pending write, so changing your mind four times still produces one
request. Every operation is idempotent last-writer-wins, which is what makes
that safe and what lets a retry or a beacon replay harmlessly.

With the server unreachable the app behaves exactly as it did before the
backend existed: work accumulates locally and the `.review.json` export is the
hand-off. That is asserted, not assumed (AC-13).

## Blind review

A reviewer sees another counselor's verdict for a scenario only once they have
saved their own for it — enforced in `api/src/blind.ts`, not by hiding things
in the UI. Independence is the point: the agreement report measures nothing if
reviewers can anchor on each other.

The server may *subset* overlays; it may never *combine* them. A filtered
`ReviewOverlay` is still a valid one, which is why no UI code changed.

## Testing

| Command | Needs | Covers |
| --- | --- | --- |
| `npm test` | nothing | units, plus the import-boundary check |
| `npm run test:db` | database | mappers, blind filter, auth, history, export parity |
| `npm run e2e` | `api:dev` | blind rule, write path, owner boundary, import, two batches |
| `npm run e2e:browser` | `api:dev` + `dev` | the real invite-link flow in Chromium |
| `npm run db:smoke` | database | schema constraints, all rolled back |

Every database suite runs inside a transaction it rolls back, so they are safe
to point at a live database.

## Export is a patch, not a re-serialisation

The two canonical files are hand-maintained and formatted differently from each
other — one leans on block literals, the other on folded scalars, section
comments between scenarios, quoted flow scalars, and `judge` before `content`.
No serializer reproduces that from a parsed tree.

So export never re-emits the file. `src/lib/yaml/source.ts` records the line
span of every scenario and every field; `patch.ts` splices replacements into
just those spans; everything else is copied through byte-for-byte. An empty
overlay exports a file identical to its input, and a one-scenario review
changes one line. Both are asserted in the test suite.

Model-level emission (`emit.ts`) is still used, but only where there is no
source text to preserve: scenarios a reviewer authored from scratch, and
`reviewer_notes` blocks that did not exist upstream.

## Contested changes never move the answer key

A reviewer who overrules a label does not rewrite `expected_tier` or
`expected_result`. The disagreement is emitted as a `reviewer_notes:` block
inside the scenario and the item is marked **Contested**. The project owner
accepts or rejects it in the resolution view (Export → Resolve contested
items); only then does the field move, and the note is kept either way.

```yaml
    expected_tier: support_and_continue      # unchanged
    reviewed_by: "JD (LPC) 2026-08-09: tier→pause_and_route, hard case"
    reviewer_notes:
      - reviewer: "JD (LPC)"
        date: "2026-08-09"
        concern: label
        proposed_tier: pause_and_route
        because: |-
          A repeated informed stop belongs with the treating clinician.
        status: contested
```

## Keyboard

| Key | Action |
| --- | --- |
| `↑` `↓` | Move through the rail |
| `1` `2` `3` | Focus the label / rationale / realism question |
| `a` | Answer the focused question with agree, and advance |
| `Ctrl/Cmd+Enter` | Save & next |
| `←` `→` `↑` `↓` | Move between rungs inside the tier ladder picker |

The agree-everything path is four keystrokes: `a` `a` `a` `Ctrl+Enter`.

## Notes on the build

- **Identity is an invite link.** One per counselor, keyed on their email,
  minted once and valid across every batch they join. The token rides in the
  URL fragment — so it never reaches a server log — and is scrubbed from the
  address bar the moment it is read. Stamps still use initials plus
  credentials: `JD (LPC)`. Email is the identity key and never appears in an
  API response.
- **Hard-case flags ride in the stamp** (`…: agree, hard case`). The spec gives
  two stamp forms by example; hard-case is review data the YAML would otherwise
  drop, and it does not change the meaning of the fragment before it.
- **Unknown categories and tiers are warnings, never rejections** — the suite is
  meant to be expandable, so novel values are carried through and badged.
- **Unrecognised scenario keys survive** a round trip; they are preserved in
  place by the patcher and surfaced in the model as `extra`.
- **The outbox lives outside the storage-version namespace.**
  `purgeOldVersions()` deletes every `srs:*` key not under the current prefix at
  module load, so an outbox inside it would be destroyed by the next version
  bump — taking unsent verdicts with it. See `NEVER_PURGE` in
  `src/store/persist.ts`.
- **Last-write-wins keeps the loser.** Two devices, one scenario: the newer
  answer stands, and the replaced one goes to `review_history` via a trigger
  rather than vanishing. There is deliberately no merge UI.
- **Notes accumulate across batches, stamps do not.** `appendStamp` dedupes;
  `buildNotes` does not. That is provenance by design, but it grows — worth a
  decision by batch three about archiving old batches' notes out of the canon.
