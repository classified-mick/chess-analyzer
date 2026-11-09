import { defineConfig } from 'vite';

// `npm run dev` (vite) proxies the API and engine socket to the node server on 5180.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5180',
      '/ws': { target: 'ws://127.0.0.1:5180', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
