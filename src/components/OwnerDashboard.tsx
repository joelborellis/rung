// Owner mode: who is working, who has stalled, and what is contested.
//
// This is the surface that replaces "wait for emails and hope". It answers the
// three questions the owner actually has during a batch — has everyone
// started, is anyone stuck, and how much disagreement is waiting for me — and
// deliberately nothing else.
//
// No per-reviewer timing or speed metrics. §2 forbids the gamified-labeling
// posture, and a dashboard that ranks clinicians by throughput is exactly
// that.

import { useEffect, useState } from 'react';
import { admin, type ProgressReport } from '../sync/admin';
import { useStore } from '../store/useStore';
import { OWNER_POLL_MS, startPolling } from '../sync/pull';
import { Eyebrow, Modal } from './ui';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function OwnerDashboard({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<ProgressReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openPanel = useStore((state) => state.openPanel);

  useEffect(() => {
    const load = async () => {
      try {
        setReport(await admin.progress());
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load progress.');
      }
    };
    void load();
    // The one surface that wants freshness — and only while it is open.
    return startPolling(OWNER_POLL_MS, load);
  }, []);

  return (
    <Modal title="Batch progress" onClose={onClose}>
      {error && (
        <p className="text-base" style={{ color: 'var(--flag)' }}>
          {error}
        </p>
      )}

      {!report && !error && <p className="text-base">Loading…</p>}

      {report && (
        <div className="flex flex-col gap-6">
          <section className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <Eyebrow>Batch</Eyebrow>
              <p className="text-lg">{report.round.label}</p>
            </div>
            <div>
              <Eyebrow>Scenarios</Eyebrow>
              <p className="text-lg tabular-nums">
                {report.totals.input + report.totals.output}
              </p>
            </div>
            <div>
              <Eyebrow>Counselors</Eyebrow>
              <p className="text-lg tabular-nums">{report.reviewers.length}</p>
            </div>
            <div>
              <Eyebrow>Unresolved contested</Eyebrow>
              <p
                className="text-lg tabular-nums"
                style={report.unresolvedContested > 0 ? { color: 'var(--flag)' } : undefined}
              >
                {report.unresolvedContested}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <Eyebrow>Who has done what</Eyebrow>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                    <th className="py-1 text-left font-normal">Counselor</th>
                    <th className="py-1 text-right font-normal">Input</th>
                    <th className="py-1 text-right font-normal">Output</th>
                    <th className="py-1 text-right font-normal">Changes</th>
                    <th className="py-1 text-right font-normal">Hard</th>
                    <th className="py-1 text-right font-normal">Authored</th>
                    <th className="py-1 text-right font-normal">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {report.reviewers.map((r) => {
                    const total = r.done.input + r.done.output;
                    const target = report.totals.input + report.totals.output;
                    return (
                      <tr key={r.personId} className="border-t" style={{ borderColor: 'var(--line)' }}>
                        <td className="py-1.5">
                          {r.displayName}
                          {r.credentials ? (
                            <span style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
                              {' '}
                              ({r.credentials})
                            </span>
                          ) : null}
                          {r.role === 'owner' && (
                            <span style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
                              {' '}
                              — you
                            </span>
                          )}
                          {r.revoked && (
                            <span style={{ color: 'var(--flag)' }}> — revoked</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {r.done.input}/{report.totals.input}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {r.done.output}/{report.totals.output}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{r.changed}</td>
                        <td className="py-1.5 text-right tabular-nums">{r.hardCases}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {r.proposals.submitted}
                          {r.proposals.draft > 0 ? ` (+${r.proposals.draft} draft)` : ''}
                        </td>
                        <td
                          className="py-1.5 text-right"
                          style={
                            total === 0
                              ? { color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }
                              : undefined
                          }
                        >
                          {total === target && target > 0 ? 'done' : ago(r.lastSeenAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {report.reviewers.length === 0 && (
              <p className="text-base" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                Nobody is enrolled in this batch yet.
              </p>
            )}
          </section>

          {report.perScenario.length > 0 && (
            <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
              <Eyebrow>Scenarios more than one person has reached</Eyebrow>
              {/* distinctLabels is a server-side proxy. The authoritative
                  contested set is computed in the browser, which knows about
                  resolutions and the canon's own label. */}
              <ul className="flex flex-col gap-1 text-sm">
                {report.perScenario.slice(0, 15).map((s) => (
                  <li key={s.scenarioId} className="flex items-baseline gap-2">
                    <span className="mono">{s.scenarioId}</span>
                    <span style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                      {s.reviewerCount} reviewers
                    </span>
                    {s.distinctLabels > 1 && (
                      <span style={{ color: 'var(--flag)' }}>
                        {s.distinctLabels} different answers
                      </span>
                    )}
                    {s.hardCaseCount > 0 && (
                      <span style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                        {s.hardCaseCount} flagged hard
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-wrap gap-2 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
            <button type="button" className="btn" onClick={() => openPanel({ kind: 'people' })}>
              Manage counselors
            </button>
            <button type="button" className="btn" onClick={() => openPanel({ kind: 'resolve' })}>
              Resolve contested items
            </button>
            <button type="button" className="btn" onClick={() => openPanel({ kind: 'agreement' })}>
              Agreement report
            </button>
            <button type="button" className="btn" onClick={() => openPanel({ kind: 'promote' })}>
              Close batch and start the next
            </button>
          </section>
        </div>
      )}
    </Modal>
  );
}
