# Spec: Scenario Review Studio

A browser-based review tool for licensed clinicians to validate, correct, and expand the safety eval scenarios for the exposure-therapy homework coach. This document is the complete build spec. The two scenario files (`input_tier_scenarios.yaml`, `output_behavior_scenarios.yaml`) are the canonical artifacts; this app is a structured editor and review-capture layer on top of them.

---

## 1. Product summary

Clinicians receive a link (or a local build) and review eval scenarios one at a time in a chat-style interface. For each scenario they record a structured verdict on three questions (label correct? rationale sound? realistic?), can propose corrections, and can author entirely new scenarios. All review data round-trips back into the YAML files via export, preserving the YAML as the single source of truth.

**Primary user:** a licensed counselor/clinician, possibly non-technical, reviewing on desktop or tablet. Assume zero tolerance for YAML syntax, file paths, or jargon.

**Secondary user:** the project owner (Joel), who imports files, monitors progress, resolves reviewer disagreement, and exports the updated canon.

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

- No backend, no accounts, no auth. Reviewer identity is honor-system (name entry). Data lives in browser storage plus manual export/import of review files.
- No running of models, no scoring harness, no analytics dashboards beyond simple progress and agreement views.
- No mobile-phone layout. Desktop and tablet only (min supported width 768px). Must not break below that, but no optimization effort.

---

## 3. Tech stack and architecture

- **Vite + React 18 + TypeScript.** Single-page app.
- **Tailwind CSS** with the design tokens in §8 defined as CSS variables in `:root` (so the token system is inspectable and themeable).
- **`js-yaml`** for parse/serialize. Serialization must preserve field order per the schemas in §4; write a custom serializer ordering rather than relying on object key order incidentally.
- **State:** Zustand (or React context if simpler) with a single store; every mutation persisted to `localStorage` immediately (debounced 500ms). Key: `srs:v1:{fileHash}:{reviewerId}`.
- **No router needed** — the app is one workspace with modal/panel states. If routing helps deep-linking to a scenario (`#/scenario/collusion-003`), use hash routing only.
- **File I/O:** import via drag-drop or file picker (`<input type="file">`); export via Blob download. If the File System Access API is available (Chromium), offer "Save back to file" as an enhancement; never require it.
- Ship with the current 24 scenarios **embedded as a default dataset** so the reviewer's first-run experience is zero-friction: open link → enter name → reviewing. Importing files replaces/merges the embedded set.

### Data flow

```
YAML files (canonical) ──import──▶ ScenarioSet (parsed, validated)
                                        │
                              ReviewOverlay (per reviewer, localStorage)
                                        │
             ┌──────────────────────────┴──────────────────────┐
        export "Review file"                        export "Merged YAML"
        (.review.json — one reviewer's              (canonical YAML with
         verdicts, portable, mergeable)              verdicts + additions merged)
```

The **ReviewOverlay** is the key architectural idea: verdicts, comments, proposed edits, and proposed new scenarios are stored as an overlay keyed by scenario `id`, never as mutations of the imported scenarios. The canonical scenario data stays immutable in memory. Merging happens only at export time. This is what makes multi-reviewer, disagreement views, and clean diffs all trivial.

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

**A. Review file** (`{reviewer}-{date}.review.json`): the reviewer's full overlay. This is what a remote clinician emails back if they aren't the one exporting the merged YAML. The app can **import** review files too, merging overlays from multiple reviewers into one workspace.

**B. Merged YAML** (the canonical export). Merge rules:

- `reviewed_by`: `"UNREVIEWED"` is replaced by, or reviews are appended to, a semicolon-separated list of stamps: `"JD (LPC) 2026-08-09: agree"` or `"JD (LPC) 2026-08-09: tier→pause_and_route"`.
- A `change` verdict on the label does **not** silently rewrite `expected_tier`/`expected_result`. Instead the app emits a `reviewer_notes:` block inside the scenario carrying the proposed change and reason, and marks the scenario in the UI as **Contested**. The project owner resolves contested scenarios in a dedicated resolution view (accept → field updated + note retained; reject → note retained). Rationale: a reviewer disagreement is data, and the canon should change deliberately, not as a side effect of export.
- Accepted `proposedTextEdits` update the fields directly.
- Submitted `ProposedScenario`s are appended to the target file's `scenarios:` list with `reviewed_by: "AUTHORED: {stamp}"`, after the owner assigns a real `id` in the resolution view (the app suggests the next id in the category's sequence).
- Everything untouched is byte-stable to the maximum extent the YAML serializer allows; field order per §4.1.

---

## 5. Screens and flows

### 5.1 Welcome / identity

First run: a single centered card. App name, one-paragraph purpose statement (write it for the clinician: what this project is, what their review does, the content warning about panic/trauma/SI scenarios). Name field, optional credentials field, "Begin review." Returning visits skip straight to the workspace with a "Reviewing as {name} — switch" affordance in the header.

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

### 5.5 Resolution view (owner mode)

Toggle in the Export menu: **"Resolve contested items."** Lists every scenario with a change-verdict or reviewer disagreement, side-by-side: current field value vs each reviewer's proposal with their reasoning. Owner actions per item: Accept proposal / Keep current / Edit manually. Also lists submitted ProposedScenarios for id assignment and acceptance. Only after resolution does "Export merged YAML" produce changed labels; export is available at any time but contested items export as notes (per §4.3) until resolved.

### 5.6 Completion

When every scenario in the active file has a verdict from the current reviewer: a quiet completion state (no confetti — see §8 tone) summarizing counts: agreed / changed / flagged hard, with two actions: **"Add a missing scenario"** and **"Export my review file."** Copy should thank them plainly and remind them the export is what makes their work usable.

---

## 6. Multi-reviewer behavior

- The overlay store is keyed per reviewer; switching reviewer (header chip) switches the visible verdict state without touching other reviewers' data.
- Importing another reviewer's `.review.json` adds their overlay. Any scenario where two reviewers' label verdicts disagree gets the amber **Contested** ring in the rail and a small inline strip on the stage: "JD proposed pause_and_route; MK agreed with support_and_continue" — with reasons on hover/expand.
- An **Agreement** summary (Export menu → "Agreement report"): per-file and per-category simple agreement percentages, and the list of disagreement scenarios. No kappa statistics in v1; the list is the product. Scenarios where licensed reviewers disagree are candidates for the `ambiguous_boundary` category — surface a one-click "suggest recategorization" on each.

---

## 7. Content handling requirements

This app displays crisis and trauma content by design. Requirements:

- The welcome card carries the content note (panic, trauma responses, and non-graphic suicidal-ideation disclosures appear in the scenarios).
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

1. Open app fresh → enter name → land on `routine-001` rendered as chat with context card and proposed answer visible: **≤ 3 interactions.**
2. Agree-path review of one scenario (all three verdicts + save): **≤ 4 clicks or ≤ 4 keystrokes**, and Save & Next advances to the next unreviewed scenario.
3. Change a tier: ladder picker opens, selecting a rung without filling "Because" blocks save with an inline explanation of why the reason is required.
4. Refresh mid-review: no data loss, returns to last position.
5. Import both YAML files (drag-drop) → replaces embedded set → header comment blocks survive to export byte-identical.
6. Export merged YAML with: one agree, one contested change, one accepted text edit, one authored scenario → diff against original shows only the expected surgical changes; file re-imports cleanly.
7. Import a second reviewer's `.review.json` with a conflicting label verdict → contested ring appears in rail, disagreement strip on stage, item listed in Agreement report and Resolution view.
8. Author a new scenario with a novel category name → appears in rail under "Your proposed scenarios" with a new-category badge → exports appended to the correct file after owner acceptance.
9. Full keyboard pass: rail navigation, verdict entry, save/advance — no mouse required. All interactive elements have visible focus.
10. No tier color is ever used as a background larger than a chip/rung; no celebratory animation exists anywhere in the build.

---

## 10. Out of scope, noted for later

Backend + real auth; live sync between reviewers; harness integration (running scenarios against a model from this UI); analytics beyond the Agreement report; comment threads / reviewer-to-reviewer discussion; version history of the canon (use git on the YAML files for now — another reason the YAML stays canonical).
