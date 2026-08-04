// File I/O (§3): Blob download for export, File System Access API as a
// progressive enhancement only, and the `.review.json` contract from §4.3 A.

import {
  REVIEW_FILE_VERSION,
  type ReviewFile,
  type ReviewOverlay,
} from '../types/review';
import { isoDate, slug } from './stamps';

export function download(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function reviewFileName(overlay: ReviewOverlay, iso: string): string {
  return `${slug(overlay.reviewer.displayName)}-${isoDate(iso)}.review.json`;
}

export function buildReviewFile(overlay: ReviewOverlay, iso: string): string {
  const payload: ReviewFile = {
    format: 'srs.review',
    version: REVIEW_FILE_VERSION,
    exportedAt: iso,
    overlay,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export class ReviewFileError extends Error {}

export function parseReviewFile(text: string): ReviewOverlay {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReviewFileError("This file isn't valid JSON — it may have been altered after export.");
  }
  const candidate = parsed as Partial<ReviewFile>;
  if (candidate?.format !== 'srs.review') {
    throw new ReviewFileError(
      "This isn't a review file. Look for one ending in .review.json.",
    );
  }
  const overlay = candidate.overlay;
  if (!overlay?.reviewer?.id || typeof overlay.reviews !== 'object') {
    throw new ReviewFileError('This review file is missing its reviewer or its verdicts.');
  }
  return {
    reviewer: overlay.reviewer,
    reviews: overlay.reviews ?? {},
    proposals: Array.isArray(overlay.proposals) ? overlay.proposals : [],
  };
}

export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsText(file);
  });
}

/** Chromium only; never required (§3). */
export function canSaveToDisk(): boolean {
  return typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

export async function saveToDisk(
  suggestedName: string,
  text: string,
  description: string,
  extension: string,
): Promise<boolean> {
  type Picker = (options: unknown) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (!picker) return false;
  try {
    const handle = await picker({
      suggestedName,
      types: [{ description, accept: { 'text/plain': [extension] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch {
    // The user cancelled, or the page lost the gesture. Fall back to download.
    return false;
  }
}
