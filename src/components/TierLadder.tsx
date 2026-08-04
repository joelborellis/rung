// Spec §8, signature element — the tier ladder.
//
// A vertical four-rung ladder echoing the fear hierarchy at the heart of
// exposure therapy. Rungs run bottom-up from no_issue to crisis_protocol. The
// selected rung is wider, full opacity, and carries a left-edge notch;
// everything else sits at 45%. In picker mode the rungs are radio buttons and
// arrow keys move between them.

import { useId } from 'react';
import { TIER_GLOSS, TIER_INDEX, TIERS, isKnownTier, type Tier, type TierValue } from '../types/scenario';

export function tierColor(tier: Tier): string {
  return `var(--tier-${TIER_INDEX[tier]})`;
}

export function tierName(tier: string): string {
  return tier.replace(/_/g, ' ');
}

type Props = {
  value: TierValue;
  onChange?: (tier: Tier) => void;
  /** Picker mode gets radio semantics and keyboard handling. */
  name?: string;
  compact?: boolean;
};

export function TierLadder({ value, onChange, name, compact = false }: Props) {
  const generatedName = useId();
  const groupName = name ?? generatedName;
  const interactive = Boolean(onChange);
  // Bottom-up: crisis_protocol renders first so no_issue sits at the bottom.
  const rungs = [...TIERS].reverse();

  function move(delta: number) {
    if (!onChange) return;
    const current = isKnownTier(String(value)) ? TIER_INDEX[value as Tier] : 0;
    const next = Math.min(TIERS.length - 1, Math.max(0, current + delta));
    onChange(TIERS[next]);
  }

  return (
    <div
      role={interactive ? 'radiogroup' : 'group'}
      aria-label="Tier ladder"
      className="flex flex-col gap-1.5"
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
                event.preventDefault();
                move(1);
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
                event.preventDefault();
                move(-1);
              }
            }
          : undefined
      }
    >
      {rungs.map((tier) => {
        const selected = String(value) === tier;
        const color = tierColor(tier);
        const body = (
          <>
            {/* Left-edge notch on the selected rung. */}
            <span
              aria-hidden="true"
              className="absolute left-0 top-0 h-full w-[3px] rounded-l"
              style={{ background: selected ? color : 'transparent' }}
            />
            {/* One line per rung: four rungs stay visible without scrolling,
                which matters because this panel is the claim under review. */}
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 self-center rounded-sm"
                style={{ background: color }}
              />
              <span className={`mono text-sm ${selected ? 'font-medium' : ''}`}>{tier}</span>
              {!compact && (
                <span
                  className="min-w-0 flex-1 text-sm"
                  style={{ color: 'color-mix(in srgb, var(--ink) 62%, transparent)' }}
                >
                  {TIER_GLOSS[tier]}
                </span>
              )}
            </span>
          </>
        );

        const className = [
          'relative flex items-center rounded-md border py-1 pl-3 pr-3 text-left',
          selected ? 'opacity-100' : 'opacity-45',
          // The selected rung extends slightly wider.
          selected ? '-mr-2' : 'mr-0',
          interactive ? 'cursor-pointer' : '',
        ].join(' ');

        const style = {
          borderColor: selected ? color : 'var(--line)',
          background: selected ? `color-mix(in srgb, ${color} 8%, var(--card))` : 'var(--card)',
        };

        if (!interactive) {
          return (
            <div key={tier} className={className} style={style} aria-current={selected}>
              {body}
            </div>
          );
        }

        return (
          <label key={tier} className={className} style={style}>
            <input
              type="radio"
              name={groupName}
              value={tier}
              checked={selected}
              onChange={() => onChange?.(tier)}
              className="sr-only"
            />
            {body}
          </label>
        );
      })}
    </div>
  );
}

/** A single tier as a chip — used in the rail, stamps, and disagreement strips. */
export function TierChip({ tier }: { tier: TierValue }) {
  const known = isKnownTier(String(tier));
  const color = known ? tierColor(tier as Tier) : 'var(--line)';
  return (
    <span className="chip mono" style={{ borderColor: color }}>
      <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {String(tier)}
      {!known && <span style={{ color: 'var(--flag)' }}>·new</span>}
    </span>
  );
}
