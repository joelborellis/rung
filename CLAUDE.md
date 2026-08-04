# Rung — clinician review app for the Handrail safety eval suite

## Source of truth
- RUNG_SPEC.md is the authoritative spec. When in doubt, re-read it.
  Do not improvise features it doesn't call for.
- The YAML scenario files are canonical data. NEVER modify
  input_tier_scenarios.yaml or output_behavior_scenarios.yaml —
  the app reads them; only the export path writes merged copies.

## Non-negotiables (spec §-refs)
- ReviewOverlay architecture (§3): verdicts are an overlay keyed by
  scenario id. Imported scenarios stay immutable in memory. No exceptions.
- Round-trip fidelity (§4.3, AC-5/6): export diffs must be surgical.
  Build and test import→export byte-stability BEFORE any UI work.
- Contested changes never silently rewrite expected_tier/expected_result.
- No gamification, no confetti, no celebratory animation, no sounds (§7).
- Design tokens in §8 are exact — hex values and fonts are not suggestions.

## Build order
1. Data model + YAML parse/serialize + round-trip tests (AC-5, AC-6)
2. Store + localStorage persistence (AC-4)
3. Workspace UI → verdict bar → authoring form → resolution view
Verify the relevant acceptance criteria (§9) after each phase.

## Stack decisions (already made — don't relitigate)
Vite + React 18 + TS, Tailwind with CSS-variable tokens, js-yaml,
Zustand, hash routing only, no backend, no auth.

## Conventions
- TypeScript strict; types in §4 are the contract, extend don't rename
- Roles render as "Client"/"Coach" in UI, never user/assistant
- Sentence case in all UI copy; buttons name their exact action