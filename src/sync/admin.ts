// Owner-only API calls. Separate from client.ts so the reviewer bundle's
// surface stays small and it is obvious which endpoints are privileged.

import type { ReviewFile } from '../types/review';

export type PersonRow = {
  id: string;
  email: string;
  displayName: string;
  credentials: string | null;
  role: 'reviewer' | 'owner';
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  hasLiveLink: boolean;
  linkLastUsed: string | null;
  linkStatus: 'revoked' | 'never-used' | 'active' | 'no-link';
  roundsJoined: number;
  inCurrentBatch: boolean;
};

export type ProgressReport = {
  round: { id: string; label: string };
  totals: { input: number; output: number };
  reviewers: Array<{
    personId: string;
    displayName: string;
    credentials: string | null;
    role: 'reviewer' | 'owner';
    revoked: boolean;
    lastSeenAt: string | null;
    done: { input: number; output: number };
    changed: number;
    hardCases: number;
    lastReviewedAt: string | null;
    proposals: { draft: number; submitted: number };
  }>;
  perScenario: Array<{
    scenarioId: string;
    fileKind: 'input' | 'output';
    reviewerCount: number;
    distinctLabels: number;
    hardCaseCount: number;
  }>;
  unresolvedContested: number;
  serverTime: string;
};

export type ExportRow = {
  id: string;
  round_id: string;
  round_label: string;
  kind: 'input' | 'output';
  sha256: string;
  scenario_count: number;
  exported_at: string;
  note: string | null;
  bytes: number;
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = (body as { error?: { message?: string } })?.error;
    throw new Error(error?.message ?? `Request failed (${response.status}).`);
  }
  return body as T;
}

export const admin = {
  progress: () => call<ProgressReport>('/api/admin/progress'),

  people: () => call<{ roundId: string | null; people: PersonRow[] }>('/api/admin/people'),

  /** `token` is present only when a new link was minted — shown once. */
  addPerson: (person: { email: string; displayName: string; credentials?: string }) =>
    call<{ person: { id: string }; token: string | null; enrolledInRound: string | null }>(
      '/api/admin/people',
      { method: 'POST', body: JSON.stringify(person) },
    ),

  revoke: (personId: string) =>
    call<{ personId: string }>(`/api/admin/people/${encodeURIComponent(personId)}/revoke`, {
      method: 'POST',
    }),

  reissue: (personId: string) =>
    call<{ personId: string; token: string }>(
      `/api/admin/people/${encodeURIComponent(personId)}/reissue`,
      { method: 'POST' },
    ),

  enrol: (personIds: string[]) =>
    call<{ roundId: string; enrolled: number }>('/api/admin/round/participants', {
      method: 'POST',
      body: JSON.stringify({ personIds }),
    }),

  openRound: (label: string) =>
    call<{ round: { id: string; label: string } }>('/api/admin/round', {
      method: 'POST',
      body: JSON.stringify({ action: 'open', label }),
    }),

  uploadDataset: (payload: {
    inputYaml: string;
    outputYaml: string;
    fileHash: string;
    scenarioIds: { input: string[]; output: string[] };
    label?: string;
  }) => call<{ datasetId: string }>('/api/admin/dataset', { method: 'POST', body: JSON.stringify(payload) }),

  /** Archive the merged bytes, open the next batch on them, close this one. */
  promote: (payload: {
    inputYaml: string;
    outputYaml: string;
    fileHash: string;
    scenarioIds: { input: string[]; output: string[] };
    nextLabel: string;
    confirm: string;
    note?: string;
  }) =>
    call<{
      closed: { id: string; label: string };
      opened: { id: string; label: string };
      archivedSha256: string;
    }>('/api/admin/round/promote', { method: 'POST', body: JSON.stringify(payload) }),

  exports: () => call<{ exports: ExportRow[] }>('/api/admin/exports'),

  exportBytes: (id: string) =>
    call<{ kind: string; sha256: string; yaml: string }>(
      `/api/admin/exports/${encodeURIComponent(id)}`,
    ),

  importOverlay: (file: ReviewFile, email?: string) =>
    call<{ person: { displayName: string }; imported: number; skipped: string[] }>(
      '/api/admin/overlays/import',
      { method: 'POST', body: JSON.stringify(email ? { ...file, email } : file) },
    ),

  allOverlays: () => call<{ round: string; files: ReviewFile[] }>('/api/admin/export/overlays'),
};
