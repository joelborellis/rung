// The single workspace (§3): no router beyond an optional hash deep-link to a
// scenario. Welcome card until a reviewer signs in, workspace thereafter.

import { useEffect } from 'react';
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
import { flushPending, storageFailed } from './store/persist';
import {
  activeGuidance,
  activeOverlay,
  activeScenario,
  progressFor,
  useStore,
  type Store,
} from './store/useStore';

export default function App() {
  const hydrated = useStore((state) => state.hydrated);
  const hydrate = useStore((state) => state.hydrate);
  const activeReviewerId = useStore((state) => state.activeReviewerId);
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

  // AC-4: nothing in flight is lost on a refresh.
  useEffect(() => {
    const onHide = () => flushPending();
    window.addEventListener('beforeunload', onHide);
    return () => window.removeEventListener('beforeunload', onHide);
  }, []);

  // Optional deep link: #/scenario/collusion-003
  useEffect(() => {
    function fromHash() {
      const match = /^#\/scenario\/(.+)$/.exec(window.location.hash);
      if (match) selectScenario(decodeURIComponent(match[1]));
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [selectScenario]);

  if (!hydrated) return null;
  if (!activeReviewerId) return <Welcome />;

  return (
    <div className="flex h-screen flex-col">
      <Header />
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
      {panel.kind === 'author' && <AuthorForm tempId={panel.tempId} onClose={closePanel} />}
      {guide.open && <HowToReview section={guide.section} onClose={closeGuide} />}
      <ImportReportPanel />
    </div>
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
