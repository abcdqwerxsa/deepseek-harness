import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The BFF serves a fixed three-file map (/, /portal.js, /portal.css) from
// ../bff/portal, so the build pins those exact names and inlines every
// asset. Any second emitted file would 404 in production.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../bff/portal',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'portal.js',
        assetFileNames: 'portal.css',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
