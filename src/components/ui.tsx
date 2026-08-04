// Small shared primitives. Everything here resolves to the §8 tokens; no
// component invents a colour or a shadow of its own.

import { useEffect, useRef, type ReactNode } from 'react';

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`eyebrow ${className}`}>{children}</div>;
}

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'aside';
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function Chip({
  children,
  tone = 'plain',
  title,
}: {
  children: ReactNode;
  tone?: 'plain' | 'accent' | 'flag';
  title?: string;
}) {
  const style =
    tone === 'accent'
      ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
      : tone === 'flag'
        ? { borderColor: 'var(--flag)', color: 'var(--flag)' }
        : undefined;
  return (
    <span className="chip" style={style} title={title}>
      {children}
    </span>
  );
}

/**
 * Progress as a ring rather than a bar: it reads as an instrument gauge and
 * takes no horizontal room in the header.
 */
export function ProgressRing({ done, total }: { done: number; total: number }) {
  const size = 30;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = total === 0 ? 0 : done / total;
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`${done} of ${total} reviewed`}
      aria-label={`${done} of ${total} scenarios reviewed`}
    >
      <svg width={size} height={size} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="text-sm tabular-nums">
        {done}/{total}
      </span>
    </span>
  );
}

export type DotState = 'unreviewed' | 'agree' | 'changed';

/**
 * Rail status dot (§5.2): empty, filled, split, plus an amber ring when the
 * scenario is contested.
 */
export function StatusDot({
  state,
  contested,
  label,
}: {
  state: DotState;
  contested?: boolean;
  label: string;
}) {
  return (
    <span
      className="relative inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center"
      title={label}
      aria-label={label}
      role="img"
    >
      {contested && (
        <span
          className="absolute inset-0 rounded-full border-2"
          style={{ borderColor: 'var(--flag)' }}
        />
      )}
      <span
        className="h-[8px] w-[8px] overflow-hidden rounded-full border"
        style={{
          borderColor: state === 'unreviewed' ? 'var(--line)' : 'var(--accent)',
          background:
            state === 'agree'
              ? 'var(--accent)'
              : state === 'changed'
                ? 'linear-gradient(90deg, var(--accent) 0 50%, transparent 50% 100%)'
                : 'transparent',
        }}
      />
    </span>
  );
}

/** The "needs extra scrutiny" and hard-case markers (§5.2). */
export function FlagGlyph({ title }: { title: string }) {
  return (
    <svg
      width="10"
      height="12"
      viewBox="0 0 10 12"
      aria-label={title}
      role="img"
      className="shrink-0"
    >
      <title>{title}</title>
      <path d="M1 1v10" stroke="var(--flag)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M1.8 1.6h6.4L6.4 4.2l1.8 2.6H1.8z" fill="var(--flag)" />
    </svg>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-3xl',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      if (event.key !== 'Tab' || !ref.current) return;
      // Keep tabbing inside the dialog (AC-9).
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
      style={{ background: 'rgba(28, 43, 51, 0.28)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`card modal-shadow my-8 w-full ${width}`}
      >
        <header className="flex items-center justify-between gap-4 border-b px-6 py-4" style={{ borderColor: 'var(--line)' }}>
          <h2 className="text-md">{title}</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

export function Labelled({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p
      className="py-6 text-center text-sm"
      style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}
    >
      {children}
    </p>
  );
}

/** A required "Because…" field that explains itself when it blocks a save. */
export function BecauseField({
  id,
  value,
  onChange,
  invalid,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <textarea
        id={id}
        className="field"
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        style={invalid ? { borderColor: 'var(--flag)' } : undefined}
      />
      {invalid && (
        <p id={`${id}-error`} className="text-sm" style={{ color: 'var(--flag)' }}>
          Say why in a sentence — the reason is what makes this usable to the team.
        </p>
      )}
    </div>
  );
}
