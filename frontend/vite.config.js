import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
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
});
