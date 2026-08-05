// Spec §3 — one Zustand store. The imported ScenarioSet is immutable; every
// reviewer opinion lives in `overlays`, keyed by scenario id. Nothing in here
// writes to a Scenario.

import { create } from 'zustand';
import { EMBEDDED_INPUT_YAML, EMBEDDED_OUTPUT_YAML } from '../data/embedded';
import { buildAgreementReport, type AgreementReport } from '../lib/agreement';
import { exportMergedYaml, exportSummary } from '../lib/export';
import { contestedIds } from '../lib/merge';
import { parseScenarioFile, YamlImportError, type ImportWarning } from '../lib/yaml/parse';
import { slug, todayIso } from '../lib/stamps';
import {
  fileHash,
  loadIndex,
  loadOverlay,
  loadSource,
  overlayKey,
  persistDebounced,
  removeKey,
  sourceKey,
  writeJson,
  INDEX_KEY,
  type ReviewerGuidance,
  type StoredSource,
  type WorkspaceIndex,
} from './persist';
import type {
  ProposedScenario,
  Resolution,
  ReviewOverlay,
  Reviewer,
  ScenarioReview,
} from '../types/review';
import type { FileKind, Scenario, ScenarioFile, ScenarioSet } from '../types/scenario';

export type ImportReport = {
  at: string;
  files: Array<{ name: string; kind: FileKind; count: number }>;
  warnings: ImportWarning[];
  errors: string[];
};

export type Panel =
  | { kind: 'none' }
  | { kind: 'author'; tempId: string }
  | { kind: 'resolve' }
  | { kind: 'agreement' }
  | { kind: 'export' }
  | { kind: 'import' }
  | { kind: 'switch-reviewer' };

/**
 * Which part of the guide to show. `all` is what the header button opens; the
 * per-kind values are what an auto-open on first landing shows.
 */
export type GuideSection = 'all' | FileKind;

export type GuideState = { open: boolean; section: GuideSection };

/**
 * The guidance record a reviewer starts with. A module-level constant rather
 * than a factory so the `activeGuidance` selector keeps returning the same
 * reference and never retriggers an effect that depends on it.
 */
const BLANK_GUIDANCE: ReviewerGuidance = {
  seenInputIntro: false,
  seenOutputIntro: false,
  nudgeDismissed: false,
};

type State = {
  hash: string;
  set: ScenarioSet;
  imported: boolean;
  reviewers: Reviewer[];
  activeReviewerId: string | null;
  overlays: Record<string, ReviewOverlay>;
  resolutions: Record<string, Resolution>;
  activeFile: FileKind;
  activeScenarioId: string | null;
  ownerMode: boolean;
  panel: Panel;
  guide: GuideState;
  guidance: Record<string, ReviewerGuidance>;
  importReport: ImportReport | null;
  hydrated: boolean;
};

type Actions = {
  hydrate: () => void;
  signIn: (displayName: string, credentials: string) => void;
  switchReviewer: (reviewerId: string) => void;
  setActiveFile: (kind: FileKind) => void;
  selectScenario: (id: string) => void;
  advance: () => void;
  saveReview: (review: ScenarioReview) => void;
  clearReview: (scenarioId: string) => void;
  upsertProposal: (proposal: ProposedScenario) => void;
  removeProposal: (tempId: string) => void;
  resolve: (resolution: Omit<Resolution, 'resolvedAt'>) => void;
  unresolve: (key: string) => void;
  setOwnerMode: (on: boolean) => void;
  openPanel: (panel: Panel) => void;
  closePanel: () => void;
  openGuide: (section?: GuideSection) => void;
  closeGuide: () => void;
  markIntroSeen: (kind: FileKind) => void;
  dismissNudge: () => void;
  importYaml: (files: Array<{ name: string; text: string }>) => void;
  importOverlay: (overlay: ReviewOverlay) => void;
  dismissImportReport: () => void;
  resetWorkspace: () => void;
};

export type Store = State & Actions;

function parseSource(source: StoredSource): { set: ScenarioSet; warnings: ImportWarning[] } {
  const input = parseScenarioFile(source.inputYaml, 'input');
  const output = parseScenarioFile(source.outputYaml, 'output');
  return {
    set: { input: input.file, output: output.file },
    warnings: [...input.warnings, ...output.warnings],
  };
}

const EMBEDDED: StoredSource = {
  inputYaml: EMBEDDED_INPUT_YAML,
  outputYaml: EMBEDDED_OUTPUT_YAML,
  imported: false,
};

function emptyOverlay(reviewer: Reviewer): ReviewOverlay {
  return { reviewer, reviews: {}, proposals: [] };
}

function indexOf(state: State): WorkspaceIndex {
  return {
    fileHash: state.hash,
    reviewers: state.reviewers,
    activeReviewerId: state.activeReviewerId,
    activeFile: state.activeFile,
    activeScenarioId: state.activeScenarioId,
    resolutions: state.resolutions,
    ownerMode: state.ownerMode,
    guidance: state.guidance,
  };
}

export const useStore = create<Store>((set, get) => {
  /** Persist the workspace index and, when given, one reviewer's overlay. */
  function persist(reviewerId?: string | null): void {
    const state = get();
    persistDebounced(INDEX_KEY, indexOf(state));
    if (reviewerId) {
      const overlay = state.overlays[reviewerId];
      if (overlay) persistDebounced(overlayKey(state.hash, reviewerId), overlay);
    }
  }

  return {
    hash: fileHash(EMBEDDED.inputYaml, EMBEDDED.outputYaml),
    set: parseSource(EMBEDDED).set,
    imported: false,
    reviewers: [],
    activeReviewerId: null,
    overlays: {},
    resolutions: {},
    activeFile: 'input',
    activeScenarioId: null,
    ownerMode: false,
    panel: { kind: 'none' },
    guide: { open: false, section: 'all' },
    guidance: {},
    importReport: null,
    hydrated: false,

    hydrate() {
      const index = loadIndex();
      const hash = index?.fileHash ?? fileHash(EMBEDDED.inputYaml, EMBEDDED.outputYaml);
      const stored = loadSource(hash);
      const source = stored ?? EMBEDDED;

      let parsed: { set: ScenarioSet; warnings: ImportWarning[] };
      try {
        parsed = parseSource(source);
      } catch {
        // A corrupted stored source must never lock the reviewer out.
        parsed = parseSource(EMBEDDED);
      }

      const reviewers = index?.reviewers ?? [];
      const overlays: Record<string, ReviewOverlay> = {};
      for (const reviewer of reviewers) {
        overlays[reviewer.id] = loadOverlay(hash, reviewer.id) ?? emptyOverlay(reviewer);
      }

      set({
        hash,
        set: parsed.set,
        imported: source.imported,
        reviewers,
        overlays,
        activeReviewerId: index?.activeReviewerId ?? null,
        activeFile: index?.activeFile ?? 'input',
        activeScenarioId: index?.activeScenarioId ?? parsed.set.input.scenarios[0]?.id ?? null,
        resolutions: index?.resolutions ?? {},
        ownerMode: index?.ownerMode ?? false,
        guidance: index?.guidance ?? {},
        hydrated: true,
      });
    },

    signIn(displayName, credentials) {
      const trimmed = displayName.trim();
      const id = slug(trimmed);
      const reviewer: Reviewer = credentials.trim()
        ? { id, displayName: trimmed, credentials: credentials.trim() }
        : { id, displayName: trimmed };
      set((state) => {
        const exists = state.reviewers.some((entry) => entry.id === id);
        return {
          reviewers: exists
            ? state.reviewers.map((entry) => (entry.id === id ? reviewer : entry))
            : [...state.reviewers, reviewer],
          overlays: {
            ...state.overlays,
            [id]: state.overlays[id]
              ? { ...state.overlays[id], reviewer }
              : emptyOverlay(reviewer),
          },
          activeReviewerId: id,
          activeScenarioId:
            state.activeScenarioId ?? state.set[state.activeFile].scenarios[0]?.id ?? null,
          panel: { kind: 'none' } as Panel,
        };
      });
      persist(id);
    },

    switchReviewer(reviewerId) {
      set((state) => ({
        activeReviewerId: reviewerId,
        overlays: state.overlays[reviewerId]
          ? state.overlays
          : {
              ...state.overlays,
              [reviewerId]: emptyOverlay(
                state.reviewers.find((entry) => entry.id === reviewerId) ?? {
                  id: reviewerId,
                  displayName: reviewerId,
                },
              ),
            },
        panel: { kind: 'none' } as Panel,
      }));
      persist(reviewerId);
    },

    setActiveFile(kind) {
      set((state) => ({
        activeFile: kind,
        activeScenarioId: state.set[kind].scenarios[0]?.id ?? null,
      }));
      persist();
    },

    selectScenario(id) {
      set({ activeScenarioId: id });
      persist();
    },

    advance() {
      const state = get();
      const overlay = state.activeReviewerId ? state.overlays[state.activeReviewerId] : undefined;
      const scenarios = state.set[state.activeFile].scenarios;
      const currentIndex = scenarios.findIndex((s) => s.id === state.activeScenarioId);
      const reviewed = (scenario: Scenario) => Boolean(overlay?.reviews[scenario.id]);
      // Next unreviewed after the cursor, else the first unreviewed anywhere.
      const after = scenarios.slice(currentIndex + 1).find((s) => !reviewed(s));
      const anywhere = scenarios.find((s) => !reviewed(s));
      const next = after ?? anywhere;
      if (next) {
        set({ activeScenarioId: next.id });
        persist();
      }
    },

    saveReview(review) {
      const reviewerId = get().activeReviewerId;
      if (!reviewerId) return;
      set((state) => {
        const overlay = state.overlays[reviewerId];
        if (!overlay) return state;
        return {
          overlays: {
            ...state.overlays,
            [reviewerId]: {
              ...overlay,
              reviews: { ...overlay.reviews, [review.scenarioId]: review },
            },
          },
        };
      });
      persist(reviewerId);
    },

    clearReview(scenarioId) {
      const reviewerId = get().activeReviewerId;
      if (!reviewerId) return;
      set((state) => {
        const overlay = state.overlays[reviewerId];
        if (!overlay) return state;
        const reviews = { ...overlay.reviews };
        delete reviews[scenarioId];
        return { overlays: { ...state.overlays, [reviewerId]: { ...overlay, reviews } } };
      });
      persist(reviewerId);
    },

    upsertProposal(proposal) {
      const reviewerId = proposal.authorId;
      set((state) => {
        const overlay = state.overlays[reviewerId];
        if (!overlay) return state;
        const exists = overlay.proposals.some((entry) => entry.tempId === proposal.tempId);
        return {
          overlays: {
            ...state.overlays,
            [reviewerId]: {
              ...overlay,
              proposals: exists
                ? overlay.proposals.map((entry) =>
                    entry.tempId === proposal.tempId ? proposal : entry,
                  )
                : [...overlay.proposals, proposal],
            },
          },
        };
      });
      persist(reviewerId);
    },

    removeProposal(tempId) {
      const reviewerId = get().activeReviewerId;
      if (!reviewerId) return;
      set((state) => {
        const overlay = state.overlays[reviewerId];
        if (!overlay) return state;
        return {
          overlays: {
            ...state.overlays,
            [reviewerId]: {
              ...overlay,
              proposals: overlay.proposals.filter((entry) => entry.tempId !== tempId),
            },
          },
        };
      });
      persist(reviewerId);
    },

    resolve(resolution) {
      set((state) => ({
        resolutions: {
          ...state.resolutions,
          [resolution.key]: { ...resolution, resolvedAt: todayIso() },
        },
      }));
      persist();
    },

    unresolve(key) {
      set((state) => {
        const resolutions = { ...state.resolutions };
        delete resolutions[key];
        return { resolutions };
      });
      persist();
    },

    setOwnerMode(on) {
      set({ ownerMode: on });
      persist();
    },

    openPanel(panel) {
      set({ panel });
    },

    closePanel() {
      set({ panel: { kind: 'none' } });
    },

    // The guide is its own surface rather than a Panel: an auto-open must never
    // displace an export or resolution panel the reviewer already opened.
    openGuide(section = 'all') {
      set({ guide: { open: true, section } });
    },

    closeGuide() {
      set((state) => ({ guide: { ...state.guide, open: false } }));
    },

    markIntroSeen(kind) {
      const reviewerId = get().activeReviewerId;
      if (!reviewerId) return;
      const field = kind === 'input' ? 'seenInputIntro' : 'seenOutputIntro';
      set((state) => {
        const current = state.guidance[reviewerId] ?? BLANK_GUIDANCE;
        if (current[field]) return state;
        return {
          guidance: { ...state.guidance, [reviewerId]: { ...current, [field]: true } },
        };
      });
      persist();
    },

    dismissNudge() {
      const reviewerId = get().activeReviewerId;
      if (!reviewerId) return;
      set((state) => {
        const current = state.guidance[reviewerId] ?? BLANK_GUIDANCE;
        if (current.nudgeDismissed) return state;
        return {
          guidance: { ...state.guidance, [reviewerId]: { ...current, nudgeDismissed: true } },
        };
      });
      persist();
    },

    importYaml(files) {
      const errors: string[] = [];
      const warnings: ImportWarning[] = [];
      const report: ImportReport['files'] = [];
      let inputFile: ScenarioFile | null = null;
      let outputFile: ScenarioFile | null = null;
      const texts: Partial<Record<FileKind, string>> = {};

      for (const entry of files) {
        const kind: FileKind = /^\s*expected_result\s*:/m.test(entry.text) ? 'output' : 'input';
        try {
          const result = parseScenarioFile(entry.text, kind);
          warnings.push(...result.warnings);
          report.push({ name: entry.name, kind, count: result.file.scenarios.length });
          texts[kind] = entry.text;
          if (kind === 'input') inputFile = result.file;
          else outputFile = result.file;
        } catch (error) {
          const message =
            error instanceof YamlImportError
              ? `${entry.name}: ${error.message}`
              : `${entry.name}: ${(error as Error).message}`;
          errors.push(message);
        }
      }

      if (!inputFile && !outputFile) {
        set({ importReport: { at: todayIso(), files: report, warnings, errors } });
        return;
      }

      const state = get();
      // A reviewer may drop only one of the two files; the other stays as-is.
      const nextInputYaml = texts.input ?? state.set.input.source;
      const nextOutputYaml = texts.output ?? state.set.output.source;
      const nextHash = fileHash(nextInputYaml, nextOutputYaml);
      const source: StoredSource = {
        inputYaml: nextInputYaml,
        outputYaml: nextOutputYaml,
        imported: true,
      };
      writeJson(sourceKey(nextHash), source);

      // Carry the existing overlays across to the new dataset key. Verdicts are
      // keyed by scenario id, so they survive a re-import of the same suite.
      for (const [reviewerId, overlay] of Object.entries(state.overlays)) {
        writeJson(overlayKey(nextHash, reviewerId), overlay);
      }

      const nextSet: ScenarioSet = {
        input: inputFile ?? state.set.input,
        output: outputFile ?? state.set.output,
      };

      set({
        hash: nextHash,
        set: nextSet,
        imported: true,
        activeScenarioId: nextSet[state.activeFile].scenarios[0]?.id ?? null,
        importReport: { at: todayIso(), files: report, warnings, errors },
        panel: { kind: 'none' },
      });
      persist(get().activeReviewerId);
    },

    importOverlay(overlay) {
      set((state) => {
        const exists = state.reviewers.some((entry) => entry.id === overlay.reviewer.id);
        const existing = state.overlays[overlay.reviewer.id];
        // Merge rather than replace, so a partial file never drops verdicts
        // already in the workspace for that reviewer.
        const merged: ReviewOverlay = {
          reviewer: overlay.reviewer,
          reviews: { ...(existing?.reviews ?? {}), ...overlay.reviews },
          proposals: [
            ...(existing?.proposals ?? []).filter(
              (entry) => !overlay.proposals.some((incoming) => incoming.tempId === entry.tempId),
            ),
            ...overlay.proposals,
          ],
        };
        return {
          reviewers: exists ? state.reviewers : [...state.reviewers, overlay.reviewer],
          overlays: { ...state.overlays, [overlay.reviewer.id]: merged },
        };
      });
      writeJson(overlayKey(get().hash, overlay.reviewer.id), get().overlays[overlay.reviewer.id]);
      persist();
    },

    dismissImportReport() {
      set({ importReport: null });
    },

    resetWorkspace() {
      const state = get();
      for (const reviewer of state.reviewers) {
        removeKey(overlayKey(state.hash, reviewer.id));
      }
      removeKey(sourceKey(state.hash));
      removeKey(INDEX_KEY);
      const embedded = parseSource(EMBEDDED);
      set({
        hash: fileHash(EMBEDDED.inputYaml, EMBEDDED.outputYaml),
        set: embedded.set,
        imported: false,
        reviewers: [],
        activeReviewerId: null,
        overlays: {},
        resolutions: {},
        activeFile: 'input',
        activeScenarioId: embedded.set.input.scenarios[0]?.id ?? null,
        ownerMode: false,
        panel: { kind: 'none' },
        guide: { open: false, section: 'all' },
        guidance: {},
        importReport: null,
      });
    },
  };
});

// ---- Selectors -------------------------------------------------------------

export function activeReviewer(state: Store): Reviewer | null {
  return state.reviewers.find((entry) => entry.id === state.activeReviewerId) ?? null;
}

export function activeOverlay(state: Store): ReviewOverlay | null {
  return state.activeReviewerId ? state.overlays[state.activeReviewerId] ?? null : null;
}

export function activeGuidance(state: Store): ReviewerGuidance {
  return (state.activeReviewerId && state.guidance[state.activeReviewerId]) || BLANK_GUIDANCE;
}

export function allOverlays(state: Store): ReviewOverlay[] {
  return state.reviewers
    .map((reviewer) => state.overlays[reviewer.id])
    .filter((overlay): overlay is ReviewOverlay => Boolean(overlay));
}

export function activeFileScenarios(state: Store): Scenario[] {
  return state.set[state.activeFile].scenarios;
}

export function activeScenario(state: Store): Scenario | null {
  return activeFileScenarios(state).find((s) => s.id === state.activeScenarioId) ?? null;
}

export function contestedForFile(state: Store, kind: FileKind): Set<string> {
  return contestedIds(state.set[kind], allOverlays(state), state.resolutions);
}

export function agreementFor(state: Store, kind: FileKind): AgreementReport {
  return buildAgreementReport(state.set[kind], allOverlays(state));
}

export function mergedYaml(state: Store, kind: FileKind): string {
  return exportMergedYaml({
    file: state.set[kind],
    overlays: allOverlays(state),
    resolutions: state.resolutions,
  });
}

export function mergedSummary(state: Store, kind: FileKind): { changed: number; appended: number } {
  return exportSummary({
    file: state.set[kind],
    overlays: allOverlays(state),
    resolutions: state.resolutions,
  });
}

export function progressFor(state: Store, kind: FileKind): { done: number; total: number } {
  const overlay = activeOverlay(state);
  const scenarios = state.set[kind].scenarios;
  const done = overlay
    ? scenarios.filter((scenario) => Boolean(overlay.reviews[scenario.id])).length
    : 0;
  return { done, total: scenarios.length };
}

const ID_SHAPE = /^(.*)-(\d+)$/;

/** The prefix a category's ids actually use, e.g. over_rigidity → "rigidity". */
export function idPrefixFor(scenarios: Scenario[], category: string): string | null {
  const counts = new Map<string, number>();
  for (const scenario of scenarios) {
    if (String(scenario.category) !== category) continue;
    const match = ID_SHAPE.exec(scenario.id);
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

/**
 * The next id in a category's sequence (§4.3). Id prefixes in the canon do not
 * derive from the category name — `over_rigidity` uses `rigidity-NNN` and
 * `crisis_mishandling` uses `crisis-out-NNN` — so read the prefix off the ids
 * the category already uses and only fall back to the name for a brand-new one.
 */
export function nextProposalId(state: Store, category: string, kind: FileKind): string {
  const scenarios = state.set[kind].scenarios;
  const fromName =
    category.replace(/_/g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'scenario';
  const prefix = idPrefixFor(scenarios, category) ?? fromName;

  // Ids already claimed by other pending proposals count as taken, so two
  // submissions in one workspace can't be assigned the same id.
  const claimed = allOverlays(state)
    .flatMap((overlay) => overlay.proposals)
    .filter((proposal) => proposal.targetFile === kind)
    .map((proposal) => proposal.assignedId ?? '');

  const highest = [...scenarios.map((scenario) => scenario.id), ...claimed].reduce((max, id) => {
    const match = ID_SHAPE.exec(id);
    if (!match || match[1] !== prefix) return max;
    return Math.max(max, Number.parseInt(match[2], 10) || 0);
  }, 0);

  return `${prefix}-${String(highest + 1).padStart(3, '0')}`;
}
