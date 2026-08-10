// The single workspace (§3): no router beyond an optional hash deep-link to a
// scenario. Welcome card until a reviewer signs in, workspace thereafter.

import { useEffect, useState } from 'react';
import { Completion } from './components/Completion';
import { Header } from './components/Header';
import {
  AgreementPanel,
  ExportPanel,
  ImportPanel,
  ImportReportPanel,
  SwitchReviewerPanel,
} from './components/Panels';
import { AuthorForm } from './components/AuthorForm';
import { HowToReview } from './components/HowToReview';
import { Rail } from './components/Rail';
import { ResolutionView } from './components/ResolutionView';
import { Stage } from './components/Stage';
import { VerdictBar } from './components/VerdictBar';
import { Welcome } from './components/Welcome';
import { ContentNote, hasSeenContentNote } from './components/ContentNote';
import { OwnerDashboard } from './components/OwnerDashboard';
import { PeopleAdmin } from './components/PeopleAdmin';
import { PromotePanel } from './components/PromotePanel';
import { flushPending, storageFailed } from './store/persist';
import {
  activeGuidance,
  activeOverlay,
  activeScenario,
  progressFor,
  useStore,
  type Store,
} from './store/useStore';
import { establishSession } from './sync/session';
import { startDrainLoop } from './sync/drain';
import { OWNER_POLL_MS, REVIEWER_POLL_MS, startPolling } from './sync/pull';
import { parseHash } from './sync/route';
import { api } from './sync/client';
import { useSyncStore } from './sync/useSyncStore';

export default function App() {
  const hydrated = useStore((state) => state.hydrated);
  const hydrate = useStore((state) => state.hydrate);
  const adoptSession = useStore((state) => state.adoptSession);
  const applyServerPull = useStore((state) => state.applyServerPull);
  const activeReviewerId = useStore((state) => state.activeReviewerId);
  const syncStatus = useSyncStore((s) => s.status);
  const syncRole = useSyncStore((s) => s.role);
  const [sessionSettled, setSessionSettled] = useState(false);
  const [needsContentNote, setNeedsContentNote] = useState(false);
  const activeFile = useStore((state) => state.activeFile);
  const panel = useStore((state) => state.panel);
  const closePanel = useStore((state) => state.closePanel);
  const selectScenario = useStore((state) => state.selectScenario);
  const guide = useStore((state) => state.guide);
  const guidance = useStore(activeGuidance);
  const openGuide = useStore((state) => state.openGuide);
  const closeGuide = useStore((state) => state.closeGuide);
  const markIntroSeen = useStore((state) => state.markIntroSeen);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Sign in behind the first paint.
  //
  // The workspace has already rendered from the embedded dataset by the time
  // this runs, so nothing the reviewer sees waits on the network — that is
  // what keeps AC-1 at two interactions and makes AC-13 (a whole session with
  // the API down) work rather than merely degrade.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;

    void (async () => {
      const result = await establishSession();
      if (cancelled) return;

      if (result.mode === 'synced') {
        const { bootstrap } = result;
        adoptSession({
          reviewer: bootstrap.reviewer,
          overlays: bootstrap.overlays,
          resolutions: bootstrap.resolutions,
        });
        // The invite path skips the Welcome card, so the §7 content note and
        // the judge-the-coach rule have to be shown here instead.
        if (!hasSeenContentNote(bootstrap.reviewer.id)) setNeedsContentNote(true);
      }
      setSessionSettled(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, adoptSession]);

  // Send queued work; the triggers are online, visible, a safety timer, and
  // pagehide. Never on the Save & next path.
  useEffect(() => {
    if (syncStatus === 'local') return;
    return startDrainLoop();
  }, [syncStatus]);

  // Pull other people's work. Slow for reviewers — the blind rule means new
  // data only ever appears for scenarios they have already finished, so
  // nothing on screen can change under them.
  useEffect(() => {
    if (syncStatus === 'local' || !activeReviewerId) return;
    const interval = syncRole === 'owner' ? OWNER_POLL_MS : REVIEWER_POLL_MS;
    return startPolling(interval, async () => {
      try {
        const { overlays, resolutions } = await api.overlays(
          useSyncStore.getState().lastSyncedAt,
        );
        applyServerPull({ overlays, resolutions });
        useSyncStore.getState().set({ lastSyncedAt: new Date().toISOString() });
      } catch {
        // The drain loop owns the offline banner; a failed poll is silent.
      }
    });
  }, [syncStatus, syncRole, activeReviewerId, applyServerPull]);

  // The two kinds of scenario ask different questions, so each gets its intro
  // once — on arrival, not on request. Reopening the guide from the header is
  // always the full document.
  useEffect(() => {
    if (!hydrated || !activeReviewerId) return;
    const seen = activeFile === 'input' ? guidance.seenInputIntro : guidance.seenOutputIntro;
    if (seen) return;
    openGuide(activeFile);
    markIntroSeen(activeFile);
  }, [hydrated, activeReviewerId, activeFile, guidance, openGuide, markIntroSeen]);

  // AC-4: nothing in flight is lost on a refresh or a tab close. `pagehide`
  // rather than `beforeunload` — the latter never fires on iPadOS, and §2
  // supports tablets. `visibilitychange` covers the app being backgrounded
  // and then killed, which fires no unload event at all.
  useEffect(() => {
    const onHide = () => flushPending();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPending();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Optional deep link: #/scenario/collusion-003. The token form (#/t/<token>)
  // is consumed and scrubbed by establishSession before this runs, so by now
  // the hash carries at most a scenario id.
  useEffect(() => {
    function fromHash() {
      const { scenarioId } = parseHash(window.location.hash);
      if (scenarioId) selectScenario(scenarioId);
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [selectScenario]);

  if (!hydrated) return null;
  // Wait for the session before deciding between Welcome and the workspace,
  // or an invited reviewer would see the name form flash past first.
  if (!sessionSettled) return null;
  if (activeReviewerId && needsContentNote) {
    return (
      <ContentNote reviewerId={activeReviewerId} onBegin={() => setNeedsContentNote(false)} />
    );
  }
  if (!activeReviewerId) return <Welcome />;

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <SyncBanner />
      {storageFailed() && (
        <p
          className="border-b px-5 py-2 text-sm"
          style={{ borderColor: 'var(--flag)', color: 'var(--flag)' }}
        >
          This browser is blocking local storage, so your verdicts won't survive a refresh. Export
          your review file before closing the tab.
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <Rail />
        <Workspace />
      </div>

      {panel.kind === 'export' && <ExportPanel onClose={closePanel} />}
      {panel.kind === 'agreement' && <AgreementPanel onClose={closePanel} />}
      {panel.kind === 'resolve' && <ResolutionView onClose={closePanel} />}
      {panel.kind === 'import' && <ImportPanel onClose={closePanel} />}
      {panel.kind === 'switch-reviewer' && <SwitchReviewerPanel onClose={closePanel} />}
      {panel.kind === 'dashboard' && <OwnerDashboard onClose={closePanel} />}
      {panel.kind === 'people' && <PeopleAdmin onClose={closePanel} />}
      {panel.kind === 'promote' && <PromotePanel onClose={closePanel} />}
      {panel.kind === 'author' && <AuthorForm tempId={panel.tempId} onClose={closePanel} />}
      {guide.open && <HowToReview section={guide.section} onClose={closeGuide} />}
      <ImportReportPanel />
    </div>
  );
}

/**
 * The two sync states worth interrupting for. Everything else lives quietly in
 * the header chip — a banner for ordinary offline blips would be noise, and
 * §7 asks for a clinical instrument rather than an anxious one.
 */
function SyncBanner() {
  const status = useSyncStore((s) => s.status);
  const dead = useSyncStore((s) => s.dead);
  const openPanel = useStore((state) => state.openPanel);

  if (status !== 'signed-out' && dead.length === 0) return null;

  return (
    <p
      className="flex flex-wrap items-center gap-3 border-b px-5 py-2 text-sm"
      style={{ borderColor: 'var(--flag)', color: 'var(--flag)' }}
    >
      {status === 'signed-out' ? (
        <>
          Your session ended, so new verdicts aren't reaching the server. Open your review link
          again — nothing you've done is lost.
        </>
      ) : (
        <>
          {dead.length} {dead.length === 1 ? 'verdict' : 'verdicts'} couldn't be saved to the
          server. Export your review file and send it to Joel so the work isn't lost.
        </>
      )}
      <button
        type="button"
        className="btn"
        style={{ borderColor: 'var(--flag)', color: 'var(--flag)' }}
        onClick={() => openPanel({ kind: 'export' })}
      >
        Export my review file
      </button>
    </p>
  );
}

function Workspace() {
  const scenario = useStore(activeScenario);
  const overlay = useStore(activeOverlay);
  const progress = useStore((state: Store) => progressFor(state, state.activeFile));
  const guidance = useStore(activeGuidance);
  const dismissNudge = useStore((state) => state.dismissNudge);

  const complete = progress.total > 0 && progress.done === progress.total;
  // "Very first unreviewed scenario" — nothing saved yet, in either file.
  const showNudge =
    !guidance.nudgeDismissed && Object.keys(overlay?.reviews ?? {}).length === 0;

  if (!scenario) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-base" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
          No scenario selected. Pick one from the list.
        </p>
      </main>
    );
  }

  // Once the file is done, show the completion state instead of re-presenting
  // the last scenario — but only when the reviewer has nothing left to revisit.
  if (complete && !overlay?.reviews[scenario.id]) {
    return (
      <main className="scroll-quiet min-w-0 flex-1 overflow-y-auto">
        <Completion />
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <Stage scenario={scenario} />
        {complete && <Completion />}
      </div>
      {showNudge && <FirstScenarioNudge onDismiss={dismissNudge} />}
      <VerdictBar scenario={scenario} />
    </main>
  );
}

/** Shown once, on the reviewer's first scenario: the order to read things in. */
function FirstScenarioNudge({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="border-t"
      style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5">
        <p className="min-w-[280px] flex-1 text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 70%, transparent)' }}>
          First one: read the envelope, then the chat, then the proposed answer — then answer the
          three questions below. The <strong className="font-medium">Guide</strong> in the header
          stays available throughout.
        </p>
        <button type="button" className="btn text-sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
