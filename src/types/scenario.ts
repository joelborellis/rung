// Spec §4.1 — canonical scenario schemas.
//
// The definitions moved to shared/scenario.ts so the API can be written
// against the same contract. This shim keeps every existing `../types/scenario`
// import working; import from either path.

export * from '../../shared/scenario';
