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
npm test          # round-trip and merge suites
npm run build
```

## How it fits together

```
data/*.yaml ──parse──▶ ScenarioSet (immutable in memory)
                            │
                  ReviewOverlay per reviewer (localStorage)
                            │
      ┌─────────────────────┴──────────────────────┐
  .review.json                              merged YAML
  (one reviewer, portable)                  (patched original text)
```

The **overlay** is the load-bearing idea. Verdicts, comments, proposed edits
and authored scenarios are keyed by scenario `id` and stored beside the canon,
never inside it. Merging happens only at export. That is what makes
multi-reviewer support, disagreement views, and clean diffs fall out for free.

| Path | What lives there |
| --- | --- |
| `data/` | The canonical YAML. Read by the app, written only by export. |
| `src/types/` | The §4 contract: scenarios, and the review overlay. |
| `src/lib/yaml/` | Parse, source scanning, line patching, scalar emission. |
| `src/lib/` | Merge rules, stamps, agreement report, export, file I/O. |
| `src/store/` | Zustand store and debounced `localStorage` persistence. |
| `src/components/` | Workspace, rail, stage, verdict bar, panels. |

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

- **Reviewer identity is honour-system.** No backend, no auth (§2). Stamps use
  initials plus credentials: `JD (LPC)`.
- **Hard-case flags ride in the stamp** (`…: agree, hard case`). The spec gives
  two stamp forms by example; hard-case is review data the YAML would otherwise
  drop, and it does not change the meaning of the fragment before it.
- **Unknown categories and tiers are warnings, never rejections** — the suite is
  meant to be expandable, so novel values are carried through and badged.
- **Unrecognised scenario keys survive** a round trip; they are preserved in
  place by the patcher and surfaced in the model as `extra`.
