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
import { Rail } from './components/Rail';
import { ResolutionView } from './components/ResolutionView';
import { Stage } from './components/Stage';
import { VerdictBar } from './components/VerdictBar';
import { Welcome } from './components/Welcome';
import { flushPending, storageFailed } from './store/persist';
import {
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
  const panel = useStore((state) => state.panel);
  const closePanel = useStore((state) => state.closePanel);
  const selectScenario = useStore((state) => state.selectScenario);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

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
      <ImportReportPanel />
    </div>
  );
}

function Workspace() {
  const scenario = useStore(activeScenario);
  const overlay = useStore(activeOverlay);
  const progress = useStore((state: Store) => progressFor(state, state.activeFile));

  const complete = progress.total > 0 && progress.done === progress.total;

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
      <VerdictBar scenario={scenario} />
    </main>
  );
}
