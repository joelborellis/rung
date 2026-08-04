// Spec §5.6 — the completion state. Quiet by design: counts, thanks, and the
// two things left to do. No confetti, no celebration (§7).

import { activeOverlay, useStore, type Store } from '../store/useStore';
import { FILE_LABELS } from '../types/scenario';
import { Eyebrow } from './ui';

export function Completion() {
  const overlay = useStore(activeOverlay);
  const activeFile = useStore((state) => state.activeFile);
  const scenarios = useStore((state: Store) => state.set[state.activeFile].scenarios);
  const openPanel = useStore((state) => state.openPanel);
  const selectScenario = useStore((state) => state.selectScenario);

  const reviews = scenarios
    .map((scenario) => overlay?.reviews[scenario.id])
    .filter((review): review is NonNullable<typeof review> => Boolean(review));

  const agreed = reviews.filter(
    (review) =>
      review.labelVerdict.kind === 'agree' &&
      review.rationaleVerdict.kind === 'sound' &&
      review.realismVerdict.kind === 'realistic',
  ).length;
  const changed = reviews.length - agreed;
  const hard = reviews.filter((review) => review.hardCase).length;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-14">
      <div>
        <Eyebrow>{FILE_LABELS[activeFile]} — complete</Eyebrow>
        <h2 className="mt-2 text-lg">All {scenarios.length} scenarios have your verdict.</h2>
      </div>

      <dl className="flex flex-wrap gap-8">
        <Count label="Agreed throughout" value={agreed} />
        <Count label="Changed something" value={changed} />
        <Count label="Flagged hard" value={hard} />
      </dl>

      <p className="text-base">
        Thank you — that is a real hour of clinical attention, and it is the part of this project
        that can't be automated. Your verdicts live in this browser until you export them, and the
        export is what makes them usable to anyone else.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => openPanel({ kind: 'export' })}
        >
          Export my review file
        </button>
        <button type="button" className="btn" onClick={() => openPanel({ kind: 'author', tempId: '' })}>
          Add a missing scenario
        </button>
        <button type="button" className="btn" onClick={() => selectScenario(scenarios[0].id)}>
          Back to {scenarios[0]?.id}
        </button>
      </div>

      <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
        Anything these {scenarios.length} missed? A scenario from your own practice is worth more
        than another pass over these.
      </p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="text-xl tabular-nums">{value}</dd>
    </div>
  );
}
