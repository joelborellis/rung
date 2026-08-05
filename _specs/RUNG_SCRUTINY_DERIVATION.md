# Rung — Derived Extra-Scrutiny Flag

A small change spec for the rung repo. Replaces the hardcoded four-ID
pre-flag list with a rule derived from each scenario's own properties, so the
flag scales as the scenario files grow instead of pointing at IDs that no
longer represent the hard cases. No data-model, overlay, or export changes.

## Why

`isPreFlagged` currently hardcodes `boundary-001`, `boundary-002`,
`collusion-003`, `rigidity-001` — the four the original 24-scenario spec
called out. The files have since grown to ~52 scenarios and will grow again
from counselor review, so a fixed ID list now misses most of the genuinely
hard cases (`boundary-003..008`, the new `over_rigidity` and
`false_reassurance` cases, the positive controls). Derive the flag instead.

## The rule

A scenario needs extra scrutiny if **either**:

1. its category is one where the answer key is genuinely contestable —
   `ambiguous_boundary` (input), `over_rigidity` (output), or
   `false_reassurance` (output); **or**
2. it is a positive control — an output scenario whose `expected_result` is
   `true` (correct behaviour that an over-strict reviewer or model tends to
   fail).

Deliberately **not** flagged: `crisis`, `routine`, `deterioration`,
`expected_distress`, most `collusion_with_avoidance` and `scope_drift` (their
clear cases are the point), so the flag marks roughly the hard third of the
suite and doesn't become wallpaper.

The two reasons are distinct and should drive distinct tooltip copy, so the
reviewer knows *why* a case is hard.

## Changes

### 1. `src/types/scenario.ts` — replace the ID list with a derivation

Delete `PRE_FLAGGED_IDS` and the id-based `isPreFlagged`. Replace with:

```ts
/** Categories whose answer key is genuinely contestable — every scenario in
 *  them warrants a closer look regardless of id. */
const SCRUTINY_CATEGORIES: ReadonlySet<string> = new Set([
  'ambiguous_boundary', // input: hard by definition
  'over_rigidity',      // output: the subtle consent-vs-protocol line
  'false_reassurance',  // output: the counterintuitive process-vs-content line
]);

export type ScrutinyReason = 'boundary' | 'positive_control';

/** Why a scenario needs extra scrutiny, or null if it doesn't. Derived from
 *  the scenario's own properties so it scales as the files grow. */
export function scrutinyReason(scenario: Scenario): ScrutinyReason | null {
  if (scenario.kind === 'output' && scenario.expected_result === true) {
    return 'positive_control';
  }
  if (SCRUTINY_CATEGORIES.has(String(scenario.category))) {
    return 'boundary';
  }
  return null;
}

export function needsExtraScrutiny(scenario: Scenario): boolean {
  return scrutinyReason(scenario) !== null;
}

/** Tooltip copy per reason — tells the reviewer what kind of hard this is. */
export const SCRUTINY_TOOLTIP: Record<ScrutinyReason, string> = {
  boundary:
    'Boundary case — reasonable clinicians may disagree. Check the tier/call carefully.',
  positive_control:
    'Positive control — correct behaviour that is easy to over-flag. Confirm it really should pass.',
};
```

Note the signature change: `isPreFlagged(id: string)` → `needsExtraScrutiny(scenario: Scenario)`. Both call sites already have the full scenario in scope, so this is a clean swap.

### 2. `src/components/Stage.tsx` — use the derived flag + reason-specific tooltip

Replace the import of `isPreFlagged` with `scrutinyReason` and
`SCRUTINY_TOOLTIP`. Replace the chip block (currently around lines 39–43):

```tsx
{(() => {
  const reason = scrutinyReason(scenario);
  return reason ? (
    <Chip tone="flag" title={SCRUTINY_TOOLTIP[reason]}>
      {reason === 'positive_control' ? 'positive control' : 'needs extra scrutiny'}
    </Chip>
  ) : null;
})()}
```

Positive controls get their own visible label ("positive control") because
that is a distinct, actionable thing for a reviewer to know — not just
"this is hard" but "this one is supposed to pass."

### 3. `src/components/Rail.tsx` — same derivation for the rail marker

Replace the import of `isPreFlagged` with `scrutinyReason` and
`SCRUTINY_TOOLTIP`. Replace the star block (currently around lines 129–137):

```tsx
{(() => {
  const reason = scrutinyReason(scenario);
  return reason ? (
    <span
      className="text-xs"
      style={{ color: 'var(--flag)' }}
      title={SCRUTINY_TOOLTIP[reason]}
    >
      {reason === 'positive_control' ? '◆' : '★'}
    </span>
  ) : null;
})()}
```

Distinct glyphs (★ boundary, ◆ positive control) so the rail shows the two
kinds at a glance. Keep the existing hard-case `FlagGlyph` untouched — that
is the reviewer's own flag and is separate from this derived one.

### 4. Guide copy (if the HowToReview panel from the guidance pass exists)

Add one line to the "three questions" / hard-case section:

> Some scenarios are marked **needs extra scrutiny** (a boundary case where
> clinicians may disagree) or **positive control** (correct behaviour that's
> easy to over-flag). These are the ones worth slowing down on.

## Acceptance criteria

1. No hardcoded scenario IDs remain in the scrutiny logic (`PRE_FLAGGED_IDS`
   is gone); grep for `PRE_FLAGGED` and `isPreFlagged` returns nothing.
2. All `ambiguous_boundary`, `over_rigidity`, and `false_reassurance`
   scenarios show the flag; all output scenarios with `expected_result: true`
   show the "positive control" variant.
3. `crisis` and `routine` scenarios show no scrutiny flag.
4. Hovering a flag explains *why* it is flagged, and the two reasons show
   different copy and different rail glyphs.
5. A scenario in both buckets (e.g. an `over_rigidity` positive control, if
   one exists) resolves to `positive_control` — the more specific,
   more actionable reason wins (as the function's ordering already does).
6. The reviewer's own hard-case flag is unchanged and still independent.

---

# Part 2 — Clear all existing app data (fresh start)

Independent of the scrutiny change: wipe all persisted review state so the
app starts clean for real counselors. The YAML files are already reset to
`UNREVIEWED`, but the browser still holds the earlier session — reviewers
(including `JB`), saved verdicts, resolutions, and last position all live in
`localStorage` under the `srs:v1` prefix and would otherwise reload. Clear it.

## Why a version bump, not just a button

Every reviewer opens this in their own browser, so a manual "clear" only
helps the person who clicks it. Bumping the storage version purges stale data
automatically on next load, everywhere, with no action required. That is the
reliable way to guarantee the JB session is gone for everyone.

## Changes

### 5. `src/store/persist.ts` — bump the storage version and purge old data

Change the prefix version from `v1` to `v2`:

```ts
const PREFIX = 'srs:v2';   // was 'srs:v1'
```

Then add a one-time migration that runs at module load, before any state is
read, removing every key from prior versions:

```ts
/** Remove persisted state from earlier storage versions. Runs once at load.
 *  This is what guarantees a clean start for every reviewer — the fresh-start
 *  reset for the counselor review round. */
function purgeOldVersions(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      // Any srs:* key that isn't the current PREFIX is from an old version.
      if (key && key.startsWith('srs:') && !key.startsWith(`${PREFIX}:`)) {
        stale.push(key);
      }
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Private mode / storage disabled — nothing persisted anyway.
  }
}

purgeOldVersions();
```

Ensure `purgeOldVersions()` executes at import time (module top level, after
`PREFIX` is defined), so it completes before the store hydrates.

### 6. Manual reset control (backup + future use)

Add a **Reset all review data** action in the Export menu (owner-facing area),
separated from the export items with a divider. It must confirm before acting,
because it is destructive and irreversible:

- Clicking it opens a small confirm step (inline, not a browser `confirm()`):
  > This permanently deletes every reviewer, verdict, and resolution stored in
  > this browser and starts over from the current scenario files. Exported
  > files are not affected. This cannot be undone.
  > **[Delete everything and restart]  [Cancel]**
- On confirm: remove every `localStorage` key beginning with `srs:` (all
  versions), then reload the app so it re-hydrates from the embedded/imported
  YAML with an empty overlay — landing on the Welcome/identity screen.

```ts
export function clearAllReviewData(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('srs:')) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* nothing persisted */
  }
}
```

The version bump handles the current fresh-start automatically; this control
covers repeat resets during the review rounds without another code change.

## Acceptance criteria (Part 2)

7. On first load after this change, no prior reviewer (including `JB`), verdict,
   resolution, or saved position appears — the app opens on the Welcome screen
   with an empty roster.
8. No `srs:v1:*` keys remain in `localStorage` after that first load.
9. The manual reset requires an explicit inline confirmation and, on confirm,
   returns the app to the Welcome screen with all review data gone.
10. Neither reset touches the scenario YAML files or any exported file — only
    browser-persisted review state.
