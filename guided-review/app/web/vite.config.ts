import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// The UI is served by the review server (app/server) from web/dist.
// `npm run dev:web` proxies /rpc and /events to a running server for UI work.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared') } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    proxy: {
      '/rpc': 'http://127.0.0.1:8787',
      '/events': 'http://127.0.0.1:8787'
    }
  }
})
