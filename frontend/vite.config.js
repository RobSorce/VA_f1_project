import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The GitHub Pages site (static demo, src/utils/demoMode.js) is the build of
// mode 'demo' (npm run build:demo, .github/workflows/deploy.yml), served under
// /<repository>/: DEMO_BASE (the workflow sets it from the repository name),
// else the repository's name today. Every other build keeps relative URLs.
const DEFAULT_DEMO_BASE = '/VA_f1_project/';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo' ? (process.env.DEMO_BASE || DEFAULT_DEMO_BASE) : './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,             // proxy WebSocket upgrades (e.g. /api/live/ws)
        timeout: 600000,      // 10 min — FastF1 extraction can be slow
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  // Vitest: a test without its own timeout gets 20 s, not the 5 s default.
  // In a full run (every worker busy) async tests that mount a view or read
  // the stylesheets took 3.5-4.7 s (B9), at the edge of the default
  test: {
    testTimeout: 20000,
  },
}));
