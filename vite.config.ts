import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The canonical YAML lives in /data at the repo root and is imported with
  // ?raw so the shipped build carries the default dataset (spec §3).
  server: { fs: { allow: ['.'] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
