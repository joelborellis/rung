// Bringing a session up on first load.
//
// The ordering here is what keeps AC-1 (≤3 interactions to reviewing) and the
// zero-network first paint: the workspace renders from the embedded dataset
// straight away, and everything below happens behind it. Nothing a reviewer
// sees waits on the server.
//
// If any of it fails, the app falls back to local mode and keeps working with
// localStorage and file export — exactly as it did before the backend existed
// (AC-13). A server outage must not stop a clinician reviewing.

import { api, SyncError } from './client';
import { drain } from './drain';
import { parseHash, scrubbedHash } from './route';
import { useSyncStore } from './useSyncStore';
import type { BootstrapInfo } from './client';

export const SESSION_HINT_KEY = 'srs:session';

/** Remembered across loads so we can tell "never signed in" from "signed out". */
type SessionHint = { reviewerId: string; displayName: string; role: string };

function rememberHint(hint: SessionHint): void {
  try {
    window.localStorage.setItem(SESSION_HINT_KEY, JSON.stringify(hint));
  } catch {
    /* private mode; the session still works for this tab */
  }
}

export function readHint(): SessionHint | null {
  try {
    const raw = window.localStorage.getItem(SESSION_HINT_KEY);
    return raw ? (JSON.parse(raw) as SessionHint) : null;
  } catch {
    return null;
  }
}

export function forgetHint(): void {
  try {
    window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Take the token out of the address bar immediately.
 *
 * It is in the fragment, so it never reached the server — but it is still
 * sitting where a reviewer might copy the URL into an email or a screenshot.
 * replaceState leaves no history entry, so Back does not restore it either.
 */
export function consumeToken(): string | null {
  const route = parseHash(window.location.hash);
  if (!route.token) return null;
  window.history.replaceState(null, '', scrubbedHash(route));
  return route.token;
}

export type SessionResult =
  | { mode: 'synced'; bootstrap: BootstrapInfo }
  | { mode: 'local'; reason: string };

/**
 * Resolve who this is: exchange a token if the link carried one, otherwise try
 * the existing cookie.
 */
export async function establishSession(): Promise<SessionResult> {
  const sync = useSyncStore.getState();
  const token = consumeToken();

  try {
    if (token) {
      await api.signIn(token);
    } else {
      // No token and no cookie is the ordinary local-build case, not an error.
      await api.session();
    }
  } catch (error) {
    const message = error instanceof SyncError ? error.message : 'Could not reach the server.';
    const status = error instanceof SyncError ? error.status : 0;

    if (token && status === 401) {
      // They clicked a link and it was rejected. That is worth saying plainly,
      // rather than silently dropping to local mode.
      sync.set({ status: 'signed-out', signedIn: false, lastError: message });
      return { mode: 'local', reason: message };
    }
    sync.set({ status: 'local', signedIn: false, lastError: null });
    return { mode: 'local', reason: message };
  }

  let bootstrap: BootstrapInfo;
  try {
    bootstrap = await api.bootstrap();
  } catch (error) {
    sync.set({
      status: 'offline',
      signedIn: true,
      lastError: error instanceof SyncError ? error.message : 'Could not reach the server.',
    });
    return { mode: 'local', reason: 'bootstrap failed' };
  }

  rememberHint({
    reviewerId: bootstrap.reviewer.id,
    displayName: bootstrap.reviewer.displayName,
    role: bootstrap.role,
  });

  sync.set({
    status: 'idle',
    signedIn: true,
    role: bootstrap.role,
    enrolled: bootstrap.enrolled,
    roundId: bootstrap.roundId,
    roundLabel: bootstrap.round?.label ?? null,
    lastError: null,
    lastSyncedAt: bootstrap.serverTime,
  });

  // Anything queued from a previous session goes now.
  void drain();

  return { mode: 'synced', bootstrap };
}

export async function signOut(): Promise<void> {
  try {
    await api.signOut();
  } catch {
    /* the cookie expires on its own; nothing to recover */
  }
  forgetHint();
  useSyncStore.getState().reset();
}
