// What the store calls. Six one-line functions, each synchronous.
//
// This exists so useStore imports six named functions rather than reaching
// into the outbox and the drain scheduler itself, and so the "are we even
// syncing?" check lives in one place instead of six.
//
// Deliberately NOT wired into `persist()`. That helper is also called by
// selectScenario, advance, setActiveFile, markIntroSeen and dismissNudge —
// pure navigation and UI state that must generate no network traffic at all.
// Only the six actions that carry a domain mutation queue anything.

import { scheduleDrain } from './drain';
import {
  enqueueProposal,
  enqueueProposalDelete,
  enqueueResolution,
  enqueueResolutionDelete,
  enqueueReview,
  enqueueReviewDelete,
} from './outbox';
import { useSyncStore } from './useSyncStore';
import type { ProposedScenario, Resolution, ScenarioReview } from '../types/review';

/**
 * In local mode there is no server to send to, and queueing would grow an
 * outbox nobody ever drains. The file export is the hand-off in that mode,
 * exactly as before the backend existed.
 */
function syncing(): boolean {
  return useSyncStore.getState().status !== 'local';
}

function after(size: number): void {
  useSyncStore.getState().set({ pending: size });
  scheduleDrain();
}

export function queueReview(review: ScenarioReview): void {
  if (!syncing()) return;
  after(enqueueReview(review).ops.length);
}

export function queueReviewDelete(scenarioId: string): void {
  if (!syncing()) return;
  after(enqueueReviewDelete(scenarioId).ops.length);
}

export function queueProposal(proposal: ProposedScenario): void {
  if (!syncing()) return;
  after(enqueueProposal(proposal).ops.length);
}

export function queueProposalDelete(tempId: string): void {
  if (!syncing()) return;
  after(enqueueProposalDelete(tempId).ops.length);
}

export function queueResolution(resolution: Resolution): void {
  if (!syncing()) return;
  after(enqueueResolution(resolution).ops.length);
}

export function queueResolutionDelete(key: string): void {
  if (!syncing()) return;
  after(enqueueResolutionDelete(key).ops.length);
}
