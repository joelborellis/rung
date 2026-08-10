import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The canonical YAML lives in /data at the repo root and is imported with
  // ?raw so the shipped build carries the default dataset (spec §3).
  server: {
    fs: { allow: ['.'] },
    // In production, Static Web Apps serves the SPA and /api from one origin.
    // Proxying in dev reproduces that: same-origin means no CORS, an
    // HttpOnly SameSite=Strict session cookie, and a working sendBeacon —
    // developing against a split origin would hide breakage in all three.
    proxy: {
      '/api': {
        // 127.0.0.1 rather than "localhost": on Windows that name resolves to
        // ::1 first, and the proxy hangs if the API bound to IPv4.
        target: process.env.API_ORIGIN ?? 'http://127.0.0.1:7071',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts', 'api/**/*.test.ts'],
  },
});
