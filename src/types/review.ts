// Spec §4.2 — the review overlay.
//
// The definitions moved to shared/review.ts so the API's row mappers can be
// written against the same contract — the `.review.json` file and the HTTP
// API speak exactly this shape. This shim keeps every existing
// `../types/review` import working; import from either path.

export * from '../../shared/review';
