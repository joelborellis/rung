# Spec: Scenario Review Studio

A browser-based review tool for licensed clinicians to validate, correct, and expand the safety eval scenarios for the exposure-therapy homework coach. This document is the complete build spec. The two scenario files (`input_tier_scenarios.yaml`, `output_behavior_scenarios.yaml`) are the canonical artifacts; this app is a structured editor and review-capture layer on top of them.

---

## 1. Product summary

Clinicians receive a link and review eval scenarios one at a time in a chat-style interface. For each scenario they record a structured verdict on three questions (label correct? rationale sound? realistic?), can propose corrections, and can author entirely new scenarios. All review data round-trips back into the YAML files via export, preserving the YAML as the single source of truth.

**Primary user:** a licensed counselor/clinician, possibly non-technical, reviewing on desktop or tablet. Assume zero tolerance for YAML syntax, file paths, or jargon.

**Secondary user:** the project owner (Joel), who enrols counselors, monitors progress, resolves reviewer disagreement, and exports the updated canon.

### 1.1 The batch loop

The app is used as a **repeating cycle**, not a single review pass. Everything about
identity, rounds, and promotion follows from this:

1. Joel enrols a **batch** of 3–8 counselors and sends each a link.
2. They vet the scenarios and author new ones.
3. When the batch reports done, Joel resolves the contested items.
4. He **promotes** the merged YAML: it is archived, becomes the next batch's canon,
   and the current batch closes — one action.
5. He runs evals against the archived bytes, then opens the next batch.

Two consequences shape the design:

- **A counselor's identity is their email and persists across batches.** The same person
  returns for batch 3 using the link they already have. Identity is global;
  *participation* is per-round.
- **Round N's merged YAML is round N+1's canon.** Promotion is a first-class action,
  not a manual export-and-reupload.

Batches run **strictly sequentially** — exactly one is open at a time, enforced by a
unique index.

---

## 2. Goals and non-goals

**Goals**

1. A clinician can complete a full review of 24 scenarios in under 60 minutes without instruction.
2. Every verdict is captured as structured data — no free-text-only feedback for the core three questions.
3. Multiple reviewers supported from day one; per-reviewer verdicts stored separately so inter-rater disagreement is computable and visible.
4. Reviewers can propose new scenarios and edits — the suite is expandable from inside the app, not just correctable.
5. Lossless round-trip: import YAML → review → export YAML that a human diff shows as *additive and surgical* (verdicts written into `reviewed_by`, corrections and new scenarios appended, nothing reordered or reformatted beyond the touched blocks).
6. Serious, calm, trustworthy visual design. This tool reviews content about panic, trauma, and suicidal ideation; the UI must feel like a clinical instrument, not a gamified labeling sweatshop.

**Non-goals (v1)**

- No passwords, no SSO for reviewers, no email sending. Identity arrives via a
  per-counselor invite link (§5.1); the app never sends mail.
- No running of models, no scoring harness, no analytics dashboards beyond simple progress and agreement views.
- **No per-reviewer timing or throughput metrics.** Ranking clinicians by speed is the
  gamified-labeling posture goal 6 exists to prevent.
- No mobile-phone layout. Desktop and tablet only (min supported width 768px). Must not break below that, but no optimization effort.

> **Superseded.** v1 said "No backend, no accounts, no auth… data lives in browser
> storage plus manual export/import of review files." A Postgres backend now exists, for
> the reasons in §1.1: collection by email was manual and lossy, progress was a snapshot
> rather than a signal, and the batch loop needed a promotion step. The file path
> (`.review.json`) is retained as an escape hatch and offline fallback, not as the
> primary transport.

---

## 3. Tech stack and architecture

- **Vite + React 18 + TypeScript.** Single-page app.
- **Tailwind CSS** with the design tokens in §8 defined as CSS variables in `:root` (so the token system is inspectable and themeable).
- **`js-yaml`** for parse/serialize. Serialization must preserve field order per the schemas in §4; write a custom serializer ordering rather than relying on object key order incidentally.
- **State:** Zustand with a single store; every mutation persisted to `localStorage` immediately (debounced 500ms). Key: `srs:v3:{fileHash}:{reviewerId}`.
- **No router needed** — the app is one workspace with modal/panel states. Hash routing only: `#/scenario/collusion-003`, `#/t/<token>`, or both combined.
- **File I/O:** import via drag-drop or file picker (`<input type="file">`); export via Blob download. If the File System Access API is available (Chromium), offer "Save back to file" as an enhancement; never require it.
- Ship with the scenarios **embedded as a default dataset** so first paint costs no network: open link → Begin review → reviewing. The server's copy is fetched behind that and swapped only if its hash differs.

### Backend

- **Postgres** (Azure Flexible Server) reached through a small Node API, same-origin
  with the SPA. `db/migrations/*.sql`, raw `pg`, no ORM.
- **The database stores one thing: `ReviewOverlay`,** decomposed into rows and
  reassembled into the byte-identical object on read. It never holds a merged result,
  never parses YAML, and no column means "the canon says X".
- **Identity is global, participation is per-round.** `people` is keyed on email;
  `round_participants` records who is in which batch. Invite tokens attach to the person,
  so one link works for every batch they join.
- **The canon is stored as raw TEXT.** Export is a line-span patch over exactly those
  bytes; a normalised representation would make AC-5/AC-6 unachievable.
- **The client is offline-first.** Verdicts are written to a local outbox synchronously
  and drained in the background; the network is never on the Save & next path.

### Data flow

```
YAML files (canonical) ──import──▶ ScenarioSet (parsed, validated)
                                        │
                    ReviewOverlay (per reviewer; localStorage + Postgres)
                                        │
             ┌──────────────────────────┴──────────────────────┐
        export "Review file"                        export "Merged YAML"
        (.review.json — one reviewer's              (canonical YAML with
         verdicts, portable, mergeable)              verdicts + additions merged)
                                                             │
                                                     promote to next batch
                                                    (archived + becomes canon)
```

The **ReviewOverlay** is the key architectural idea: verdicts, comments, proposed edits, and proposed new scenarios are stored as an overlay keyed by scenario `id`, never as mutations of the imported scenarios. The canonical scenario data stays immutable in memory. Merging happens only at export time. This is what makes multi-reviewer, disagreement views, and clean diffs all trivial.

**The backend does not weaken this.** The merge runs in the browser, in `mergeFile`, at
the moment an export is produced — including for promotion, where the client posts the
merged bytes and the server only archives them. The server has no code path that could
merge and no column that could hold the result. This is enforced mechanically:

```
api/**  must not import from  src/lib/**
```

`scripts/check-import-boundary.mjs` runs as part of `npm test`.

---

## 4. Data model

### 4.1 Canonical scenario schemas (import contract)

The app must parse both existing file shapes. Top-level: `{ scenarios: Scenario[] }` with header comments (preserve the header comment block verbatim on export — read the raw text above the `scenarios:` key and re-emit it).

```ts
// Shared
type Turn = { role: 'user' | 'assistant'; content: string; judge?: boolean };
type Context = {
  assigned_exercise: string;
  hierarchy_position: string;
  scope_notes: string;
};

// input_tier_scenarios.yaml
type Tier = 'no_issue' | 'support_and_continue' | 'pause_and_route' | 'crisis_protocol';
type InputScenario = {
  id: string;
  category: 'routine' | 'expected_distress' | 'deterioration' | 'out_of_scope' | 'crisis' | 'ambiguous_boundary';
  description: string;
  context: Context;
  conversation: Turn[];
  expected_tier: Tier;
  rationale: string;
  reviewed_by: string;          // "UNREVIEWED" or accumulated review stamps
};

// output_behavior_scenarios.yaml
type OutputScenario = {
  id: string;
  category: 'collusion_with_avoidance' | 'over_rigidity' | 'clinical_overreach'
          | 'scope_drift' | 'crisis_mishandling' | 'false_reassurance';
  description: string;
  context: Context;
  conversation: Turn[];          // final judged turn has judge: true
  expected_result: boolean;
  reason: string;
  feedback: string;
  reviewed_by: string;
};
```

Validation on import: unique ids, known categories/tiers (unknown ones are accepted with a warning badge, not rejected — the suite must be expandable), conversation non-empty, input scenarios end on a user turn, output scenarios contain exactly one `judge: true` turn. Show a friendly import report listing any warnings; never a raw stack trace.

### 4.2 Review overlay (app-owned)

```ts
type Verdict<T> =
  | { kind: 'agree' }
  | { kind: 'change'; proposed: T; because: string };   // because is required, min 10 chars

type ScenarioReview = {
  scenarioId: string;
  reviewerId: string;            // slug of reviewer name
  reviewedAt: string;            // ISO
  labelVerdict: Verdict<Tier | boolean>;      // tier for input file, pass/fail for output file
  rationaleVerdict: { kind: 'sound' } | { kind: 'flawed'; because: string };
  realismVerdict: { kind: 'realistic' } | { kind: 'unrealistic'; because: string };
  hardCase: boolean;             // reviewer flags this as a genuinely ambiguous case
  comment?: string;              // optional free text
  proposedTextEdits?: Partial<Pick<Scenario, 'rationale' | 'feedback' | 'description'>>;
};

type ProposedScenario = {
  tempId: string;                // e.g. "new-{reviewerId}-001"
  targetFile: 'input' | 'output';
  authorId: string;
  status: 'draft' | 'submitted';
  scenario: Partial<InputScenario | OutputScenario>;   // built via the authoring form
};

type Reviewer = { id: string; displayName: string; credentials?: string /* e.g. "LPC" */ };
```

### 4.3 Export formats

**A. Review file** (`{reviewer}-{date}.review.json`): the reviewer's full overlay. Since the backend, this is the **escape hatch** rather than the normal transport: verdicts reach the owner by syncing. It stays for three cases — a reviewer whose sync is failing, a completely offline session (AC-13), and archival. The app can **import** review files too, merging overlays into one workspace; the owner can also import one into the database.

The same shape travels both ways: the `overlay` field of a review file and the objects returned by `GET /api/overlays` are the identical `ReviewOverlay` type. One wire format, two transports — that equivalence is what makes the database a transport rather than a second model.

**B. Merged YAML** (the canonical export). Merge rules:

- `reviewed_by`: `"UNREVIEWED"` is replaced by, or reviews are appended to, a semicolon-separated list of stamps: `"JD (LPC) 2026-08-09: agree"` or `"JD (LPC) 2026-08-09: tier→pause_and_route"`.
- A `change` verdict on the label does **not** silently rewrite `expected_tier`/`expected_result`. Instead the app emits a `reviewer_notes:` block inside the scenario carrying the proposed change and reason, and marks the scenario in the UI as **Contested**. The project owner resolves contested scenarios in a dedicated resolution view (accept → field updated + note retained; reject → note retained). Rationale: a reviewer disagreement is data, and the canon should change deliberately, not as a side effect of export.
- Accepted `proposedTextEdits` update the fields directly.
- Submitted `ProposedScenario`s are appended to the target file's `scenarios:` list with `reviewed_by: "AUTHORED: {stamp}"`, after the owner assigns a real `id` in the resolution view (the app suggests the next id in the category's sequence). A unique index makes concurrent id assignment a 409 the UI retries, not a silent collision.
- Everything untouched is byte-stable to the maximum extent the YAML serializer allows; field order per §4.1.

**C. Promotion** (§1.1 step 4). The client merges as above and posts the bytes; the server archives them in `exports`, creates the next round's dataset from the same bytes, and closes the current round — in one transaction. The archive is what lets an eval run be traced to an exact canon.

Note that `reviewer_notes` accumulate across batches: `appendStamp` dedupes stamps, `buildNotes` does not dedupe notes. That is intentional provenance, but it grows monotonically, and re-importing an already-merged overlay would duplicate them — which is why `overlays/import` merges against what is stored rather than appending.

---

## 5. Screens and flows

### 5.1 Identity

**Invited path (normal).** The counselor opens `#/t/<token>`. The token *is* their
identity — no name field, no password. It is read and scrubbed from the address bar
immediately: it rides in the fragment, so it never reaches the server or a log, but it
must not sit where someone might copy or screenshot the URL.

They then see a one-time **content-note pre-roll** (`ContentNote.tsx`) carrying the §7
content warning, the judge-the-coach ground rule, and a plain statement of where their
answers go. This exists because the invited path skips the Welcome card, and losing a
safety requirement to win an interaction budget already met would be a bad trade.

Click link → Begin review = **two interactions**, inside AC-1's three.

**Fallback path.** With no token and no cookie — a local build, or a revoked link — the
original Welcome card still applies: name, optional credentials, Begin review. This is
what keeps the app usable with no server at all.

**Durability.** One link per counselor, minted once, valid for every batch they are
enrolled in. Someone not in the current batch authenticates fine and is told to wait —
that is not an error and must not read like one.

### 5.2 Workspace (the main screen)

Three-region layout:

```
┌────────────────────────────────────────────────────────────────┐
│ Header: app name · file toggle (Input 14 / Output 10) ·        │
│         progress ring · reviewer chip · Export menu            │
├──────────────┬─────────────────────────────────────────────────┤
│ Scenario     │  Scenario stage                                 │
│ rail         │   · context card (therapist envelope)           │
│ (list of     │   · conversation, chat-rendered                 │
│  ids w/      │   · proposed answer panel (tier or pass/fail    │
│  status      │     + rationale/reason/feedback)                │
│  dots)       ├─────────────────────────────────────────────────┤
│              │  Verdict bar (sticky bottom): 3 verdicts +      │
│  [+ New      │  hard-case toggle + comment + Save & Next       │
│  scenario]   │                                                 │
└──────────────┴─────────────────────────────────────────────────┘
```

**Scenario rail.** Grouped by category with category labels; each item shows id, one-line description, and a status dot: empty (unreviewed), filled (reviewed-agree), split (reviewed-with-changes), amber ring (contested / disagreement between reviewers), plus a small flag glyph if any reviewer marked hard-case. Keyboard: `↑/↓` navigate, `Enter` opens. The four pre-flagged boundary scenarios (`boundary-001`, `boundary-002`, `collusion-003`, `rigidity-001`) carry a subtle "needs extra scrutiny" marker on first import.

**Context card.** The therapist envelope rendered as a compact labeled card — *Assigned exercise*, *Hierarchy*, *Scope notes* — visually distinct from the conversation (it is metadata the coach operates under, and reviewers must judge the scenario against it). Hierarchy position rendered with the ladder motif from §8.

**Conversation.** Chat bubbles: user right-aligned, assistant left-aligned, roles labeled "Client" and "Coach" (clinician-facing vocabulary, not `user`/`assistant`). In output-file scenarios, the `judge: true` turn gets a distinct treatment — a highlighted border and an eyebrow label **"Response under review"** — because the entire verdict is about that one turn.

**Proposed answer panel.** For input scenarios: the proposed tier shown on the tier ladder (§8 signature element) with the drafted rationale beside it. For output scenarios: a large PASS or FAIL chip, the reason, and (for fails) the feedback block labeled **"What the corrected response does."** This panel is what the reviewer is agreeing with or overruling — it must read as a claim, not a fact. Eyebrow label: **"Proposed answer — your call."**

### 5.3 Verdict bar

Sticky at the bottom of the stage. Three questions, always in this order, each answerable in one click for the agree path:

1. **Label** — `Agree` | `Change…` → opens the tier ladder (input) or pass/fail toggle (output) plus a required "Because…" field.
2. **Rationale** — `Sound` | `Flawed…` → required because-field. Also an inline **"Suggest edit"** affordance that opens the rationale text in an editable diff view (proposedTextEdits).
3. **Realism** — `Realistic` | `Wouldn't happen…` → required because-field.

Plus: **Hard case** toggle (tooltip: "Genuinely ambiguous — reasonable clinicians could disagree"), an optional comment field (single-line that grows), and **Save & Next** (primary action; disabled until all three verdicts are set; `Cmd/Ctrl+Enter` shortcut). Number keys `1/2/3` focus the three verdict groups; `a` selects agree/sound/realistic for the focused group.

The agree-everything path must be exactly four keystrokes or four clicks. Throughput on the easy cases buys attention for the hard ones.

### 5.4 New scenario authoring

Entered from the rail's `+ New scenario` or from a prompt shown at review completion ("Anything these 24 missed? Add a scenario from your practice."). A guided form, not a YAML editor:

1. Which file (plain-language: "Classify a client message" vs "Judge a coach response").
2. Category picker with one-line descriptions of each category — plus "Other" with a free-text category name (this is a primary expansion mechanism; new categories are first-class, surfaced with a "new category" badge, and preserved on export).
3. Context fields (exercise, hierarchy position, scope notes) with sensible placeholders.
4. Conversation builder: alternating Client/Coach turns, add/remove/reorder; for output scenarios, a "this is the response under review" selector on assistant turns.
5. The answer: tier ladder or pass/fail + reason (+ feedback for fails).
6. Save as draft (rail section "Your proposed scenarios") or Submit.

Draft state is important: clinicians will start scenarios and get interrupted. Drafts persist like everything else.

### 5.5 Owner surfaces

**Owner mode is server-enforced authorization, not a client checkbox.** The role comes
from the session; every `/api/admin/*` endpoint re-checks it. Hiding the buttons is
cosmetic — the real control is that check plus the redaction in §6.1.

- **Resolve contested items.** Lists every scenario with a change-verdict or reviewer disagreement, side-by-side: current field value vs each reviewer's proposal with their reasoning. Owner actions per item: Accept proposal / Keep current / Edit manually. Also lists submitted ProposedScenarios for id assignment and acceptance. Only after resolution does "Export merged YAML" produce changed labels; export is available at any time but contested items export as notes (per §4.3) until resolved.
- **Batch progress.** Who is enrolled, how far each has got, how many changes and hard
  cases, when they were last seen, and the count of unresolved contested items. Polls
  every 15s while open, paused when the tab is hidden. No timing or speed metrics (§2).
- **Manage counselors.** The global roster. Add by email — adding someone who already
  exists re-enrols them and keeps their link. Mint / reissue / revoke. A minted token is
  shown **exactly once**; it is never stored in recoverable form. Revoking stops the link
  working and never deletes verdicts.
- **Close batch and start the next.** §1.1 step 4, gated on typing the batch name.

**Merged YAML export and the Agreement report are owner-only** — not as a policy choice
but as arithmetic. A reviewer's overlays arrive blind-filtered (§6.1), so a merge built
from them would contain only their own verdicts. Unhiding the button produces a
misleading file, not a leak.

### 5.6 Sync status

A quiet chip in the header: `Saved`, `Saving…`, `Offline — 3 unsent`, or `Reconnect`.
Only two states earn colour and a banner — a session that ended, and verdicts the server
refused outright. Both say to export the review file, because that is the recovery.

Sync working is the normal case and should not draw the eye. No spinner on every save.

### 5.7 Completion

When every scenario in the active file has a verdict from the current reviewer: a quiet completion state (no confetti — see §8 tone) summarizing counts: agreed / changed / flagged hard, with two actions: **"Add a missing scenario"** and **"Export my review file."** Copy should thank them plainly.

---

## 6. Multi-reviewer behavior

- The overlay store is keyed per reviewer. **Switching reviewer is owner-only** when a
  server session exists — identity comes from the invite link, so switching would be
  impersonation rather than a view toggle. In local (file-only) mode the original
  behaviour stands: one browser legitimately holds several reviewers.
- Any scenario where two reviewers' label verdicts disagree gets the amber **Contested** ring in the rail and a small inline strip on the stage: "JD proposed pause_and_route; MK agreed with support_and_continue" — with reasons on hover/expand. Reviewers see this only for scenarios they have themselves answered (§6.1).
- An **Agreement** summary (Export menu → "Agreement report"): per-file and per-category simple agreement percentages, and the list of disagreement scenarios. No kappa statistics in v1; the list is the product. Scenarios where licensed reviewers disagree are candidates for the `ambiguous_boundary` category — surface a one-click "suggest recategorization" on each. Owner-only, per §5.5.

### 6.1 Blind review

**A reviewer receives another counselor's verdict for scenario X only once they have
saved their own verdict for X. Enforced server-side.**

This is not a UI preference. The whole point of collecting several clinicians' judgments
is that they are independent — goal 3 exists to make disagreement computable. A reviewer
who sees "JD proposed pause_and_route" before forming their own view is anchored, and
the agreement percentage stops measuring anything. Enforcement is server-side because a
control the browser applies is not a control: the response must not *contain* data the
recipient is not entitled to, whatever the UI does with it.

**The rule, precisely — and note what it is not:**

> The server may **subset** the list of overlays, and subset the key set within an
> overlay's `reviews` map. It may never **combine** two overlays, never read or write a
> Scenario, and never compute a field the canon contains.

Subsetting is not merging. A filtered `ReviewOverlay` is still a valid `ReviewOverlay`,
which is why nothing downstream changed: `contestedIds` simply finds no other entries and
draws no ring. §3's invariant holds.

Specifically, for reviewer R in the open round:

- R's own overlay, complete.
- For each other participant, only the scenario ids R has answered; the reviewer is
  omitted entirely if that leaves nothing.
- Resolutions filtered the same way — the existence of one reveals that somebody
  contested that scenario.
- Other people's authored scenarios are withheld; the rail only shows R's own anyway.
- The owner sees everything: resolving disagreement cannot be done blind.

**A new batch is a fresh blind slate**, including for a returning counselor. Work in
batch 1 unlocks nothing in batch 2.

**The hole this cannot close** is the reviewer's memory: once R sees B's disagreement on
s1, R knows something about B before answering s2. Unavoidable — the alternative is
never revealing anything, which loses AC-7.

---

## 7. Content handling requirements

This app displays crisis and trauma content by design. Requirements:

- The welcome card carries the content note (panic, trauma responses, and non-graphic suicidal-ideation disclosures appear in the scenarios). **The invited path skips that card, so the pre-roll in §5.1 must carry it instead.** Whichever route a counselor takes, they see it before the first scenario.
- **Say where the data goes.** Verdicts and reasoning are stored in a private database
  under the reviewer's name, and the copy must say so plainly. Before the backend they
  never left the reviewer's machine; wording that implies that is now misleading. The
  same paragraph states that other reviewers' answers stay hidden until they have
  answered the same scenario, and why.
- Crisis-category scenarios get no special visual alarm treatment beyond their category label — reviewers are clinicians; melodramatic styling (red banners, warning icons) is both patronizing and fatiguing. Calm, consistent presentation throughout.
- No sounds. No streak mechanics, no gamification, no celebratory animation anywhere.
- The app must never edit scenario conversation content silently (e.g., no smart-quote substitution, no trimming) — reviewers are judging exact wording.

---

## 8. Design system

Design intent: a **clinical instrument** — the calm authority of a well-designed chart-review tool. Quiet surfaces, disciplined type, one domain-grounded signature element. Explicitly avoid: cream-paper + serif + terracotta portfolio styling; dark-mode-with-acid-accent dashboard styling; and any gamified labeling-tool cheerfulness.

### Tokens (define as CSS variables)

Palette — cool, low-arousal, high-legibility:

- `--ink: #1C2B33` — near-black blue-green; all primary text.
- `--surface: #F6F8F8` — cool off-white app background.
- `--card: #FFFFFF` — cards and the conversation stage.
- `--line: #D8E0E2` — hairline borders, dividers.
- `--accent: #14666B` — deep teal. The single interactive color: primary buttons, focus rings, selected states, links.
- `--flag: #B4690E` — muted amber, used only for contested/hard-case markers.
- Tier scale (used only inside the tier ladder and status dots, all desaturated):
  `--tier-0: #4E7A5A` (no_issue) · `--tier-1: #7A8A4E` (support_and_continue) · `--tier-2: #A8742C` (pause_and_route) · `--tier-3: #8C3A3A` (crisis_protocol). Never use these as large surfaces; chips, dots, and ladder rungs only.

Typography:

- Display / headings: **Schibsted Grotesk** (600/700) — used sparingly: app name, scenario ids, section headings.
- Body / UI: **IBM Plex Sans** (400/500/600), 15px base, 1.6 line-height for scenario prose.
- Mono: **IBM Plex Mono** for scenario ids in the rail, category slugs, and the export previews.
- Scale: 13 / 15 / 17 / 22 / 28. Eyebrow labels: 11px, 500, letter-spacing 0.08em, uppercase, `--ink` at 55% opacity.

Layout & texture:

- 8px spacing grid; cards with 10px radius, 1px `--line` border, **no drop shadows** except a single soft shadow on modals.
- Generous whitespace around the conversation — reading comfort is the core activity.
- Focus states always visible (2px `--accent` ring, offset 2px). `prefers-reduced-motion` respected; all transitions ≤150ms ease-out and none are load-bearing.

### Signature element: the tier ladder

Wherever a tier appears — the proposed-answer panel, the change-verdict picker, the authoring form — it renders as a **vertical four-rung ladder**, echoing the fear-hierarchy ladder at the heart of exposure therapy. Rungs ordered bottom-up from `no_issue` to `crisis_protocol`; each rung a horizontal bar in its tier color with the tier name and a one-line plain-language gloss; the selected rung extends slightly wider with a left-edge notch and full-opacity color while unselected rungs sit at 45% opacity. In picker mode the rungs are radio buttons (arrow keys move between rungs). This is the one place the design spends its boldness; everything else stays quiet.

### Voice

Sentence case everywhere. Buttons name their action exactly: "Save & next," "Export merged YAML," "Add scenario." The reviewer's three questions are phrased as questions ("Is this the right tier?" / "Is the reasoning sound?" / "Would a client say this?"). Errors state what happened and the fix ("This file isn't valid YAML — check line 41" with the parser message). Empty states direct ("No contested items. Disagreements between reviewers will appear here.").

---

## 9. Acceptance criteria

1. Open app fresh → identify → land on `routine-001` rendered as chat with context card and proposed answer visible: **≤ 3 interactions.** (Invited path: click link, Begin review = 2.)
2. Agree-path review of one scenario (all three verdicts + save): **≤ 4 clicks or ≤ 4 keystrokes**, and Save & Next advances to the next unreviewed scenario.
3. Change a tier: ladder picker opens, selecting a rung without filling "Because" blocks save with an inline explanation of why the reason is required.
4. Refresh mid-review: no data loss, returns to last position.
5. Import both YAML files (drag-drop) → replaces embedded set → header comment blocks survive to export byte-identical.
6. Export merged YAML with: one agree, one contested change, one accepted text edit, one authored scenario → diff against original shows only the expected surgical changes; file re-imports cleanly.
7. A second reviewer records a conflicting label verdict → contested ring appears in rail, disagreement strip on stage, item listed in Agreement report and Resolution view. Subject to §6.1: visible to a reviewer only once they have answered that scenario, and to the owner always.
8. Author a new scenario with a novel category name → appears in rail under "Your proposed scenarios" with a new-category badge → exports appended to the correct file after owner acceptance.
9. Full keyboard pass: rail navigation, verdict entry, save/advance — no mouse required. All interactive elements have visible focus.
10. No tier color is ever used as a background larger than a chip/rung; no celebratory animation exists anywhere in the build.

### Backend criteria

These five were added with the backend. Each covers a failure that is silent — it would
ship looking fine and be discovered later, from data already lost.

11. **Export parity.** For the same overlays, merged YAML built from database-sourced
    overlays is **byte-identical** to merged YAML built from localStorage-sourced ones.
    This is the acceptance criterion for the whole backend: if it holds, the database is
    a transport rather than a second model.
    *`src/lib/export-parity.dbtest.ts`*
12. **No leak in the raw body.** The blind rule asserted against the **serialised
    response text**, not a parsed object — a structural check passes even when the same
    reasoning leaks through a field nobody thought to look at.
    *`api/src/blind.dbtest.ts`, `db/e2e-blind.mjs`*
13. **A full offline session.** With the API unreachable throughout, a reviewer completes
    every scenario and exports a valid `.review.json`. The server being down must degrade
    to exactly the behaviour that existed before it.
    *`src/sync/offline.test.ts`*
14. **Tab-kill safety.** Save a verdict, kill the tab within 500ms, reopen: the verdict is
    present. This failed before the backend — `flushPending` cancelled pending writes
    instead of writing them.
    *`src/store/persist.test.ts`*
15. **Two full batches.** Batch 1 reviewed, resolved, promoted. Batch 2 opens on the
    promoted canon; a returning counselor uses the same link with no reissue, starts
    blind, and sees batch 1's accepted corrections in the canon. The archived export is
    byte-identical to what was promoted.
    *`db/e2e-batches.mjs`*

A criterion that can pass vacuously is worse than none: AC-15 asserts each write was
stored before asserting what is hidden, because "correctly hidden" and "never existed"
are otherwise indistinguishable.

---

## 10. Out of scope, noted for later

Harness integration (running scenarios against a model from this UI); analytics beyond the Agreement report; comment threads / reviewer-to-reviewer discussion; version history of the canon (use git on the YAML files for now — another reason the YAML stays canonical).

Deliberately **not** built alongside the backend, and each for a reason:

- **WebSockets, SSE, presence.** Data changes a few times a minute at peak; polling is correct.
- **Aggregate/majority resolution UI.** Batch size is 3–8. Revisit past ~10.
- **Cross-batch reviewer analytics.** Durable identity makes "is this counselor consistent across batches?" computable, and it is one step from scoring reviewers — the posture §2 goal 6 forbids.
- **Overlapping batches.** Strictly sequential, enforced by a unique index. Do not add a "let stragglers keep going" mode without first defining what happens when the canon changed under them.
- **A conflict-resolution UI for the two-device case.** Last-write-wins, plus `review_history` so the discarded answer is recoverable.
- **Server-side YAML parsing, merge, or export.** CI-enforced (§3).
- **Bumping `.review.json` to version 2.** It stays version 1; the database speaks the same shape, and that equivalence is the design.
- **Passwords, SSO for reviewers, email sending.** Tokens in links; the owner sends them.
