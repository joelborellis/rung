// Integration tests that need a real database. Kept out of `npm test` on
// purpose: the default suite must stay runnable with no network and no
// credentials. Run with `npm run test:db`.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.dbtest.ts'],
    setupFiles: ['./vitest.db.setup.ts'],
    // Every test opens its own transaction and rolls back; running files in
    // parallel against one small pool just causes contention.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
