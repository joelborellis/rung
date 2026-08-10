// Typed wrapper over fetch. One function per endpoint, no state, no retries —
// retry policy belongs to the outbox, which knows what is safe to replay.
//
// Same-origin by construction (Static Web Apps serves the SPA and /api
// together), so the session cookie rides along with `credentials: 'same-origin'`
// and there is no CORS to configure.

import type { ProposedScenario, Resolution, ReviewOverlay, Reviewer, ScenarioReview } from '../types/review';

export type Role = 'reviewer' | 'owner';

export type SessionInfo = {
  reviewer: Reviewer;
  role: Role;
  roundId: string | null;
  enrolled: boolean;
};

export type BootstrapInfo = SessionInfo & {
  round?: { id: string; label: string };
  datasetFileHash?: string | null;
  overlays: ReviewOverlay[];
  resolutions: Record<string, Resolution>;
  serverTime: string;
};

export type DatasetInfo = {
  id: string;
  fileHash: string;
  sha256: string;
  inputYaml: string;
  outputYaml: string;
  scenarioIds: { input: string[]; output: string[] };
};

export type BatchResult = {
  applied: string[];
  /** Accepted but not written: the server already holds something newer. */
  stale: string[];
  rejected: Array<{ scenarioId: string; code: string; message: string }>;
  serverTime: string;
};

/** An error carrying the status, so callers can tell 401 from 500 from 400. */
export class SyncError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }

  /** 5xx and network failures are worth retrying; 4xx will fail identically. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    // Offline, DNS, TLS, or the tab was backgrounded mid-flight. Status 0
    // marks it retryable.
    throw new SyncError(0, 'OFFLINE', cause instanceof Error ? cause.message : 'Network error');
  }

  if (response.status === 204 || response.status === 304) return undefined as T;

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new SyncError(response.status, 'BAD_RESPONSE', 'The server sent something unreadable.');
  }

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } })?.error;
    throw new SyncError(
      response.status,
      error?.code ?? 'ERROR',
      error?.message ?? `Request failed (${response.status}).`,
    );
  }

  return body as T;
}

export const api = {
  signIn: (token: string) =>
    call<SessionInfo>('/api/session', { method: 'POST', body: JSON.stringify({ token }) }),

  session: () => call<SessionInfo>('/api/session'),

  signOut: () => call<void>('/api/session', { method: 'DELETE' }),

  bootstrap: () => call<BootstrapInfo>('/api/bootstrap'),

  dataset: () => call<DatasetInfo>('/api/dataset'),

  overlays: (since?: string | null) =>
    call<{ overlays: ReviewOverlay[]; resolutions: Record<string, Resolution>; serverTime: string }>(
      since ? `/api/overlays?since=${encodeURIComponent(since)}` : '/api/overlays',
    ),

  reviewsBatch: (upserts: ScenarioReview[], deletes: string[]) =>
    call<BatchResult>('/api/reviews:batch', {
      method: 'POST',
      body: JSON.stringify({ upserts, deletes }),
    }),

  putProposal: (proposal: ProposedScenario) =>
    call<{ tempId: string }>(`/api/proposals/${encodeURIComponent(proposal.tempId)}`, {
      method: 'PUT',
      body: JSON.stringify(proposal),
    }),

  deleteProposal: (tempId: string) =>
    call<void>(`/api/proposals/${encodeURIComponent(tempId)}`, { method: 'DELETE' }),

  putResolution: (resolution: Resolution) =>
    call<{ key: string }>(`/api/resolutions/${encodeURIComponent(resolution.key)}`, {
      method: 'PUT',
      body: JSON.stringify(resolution),
    }),

  deleteResolution: (key: string) =>
    call<void>(`/api/resolutions/${encodeURIComponent(key)}`, { method: 'DELETE' }),
};

export type Api = typeof api;
