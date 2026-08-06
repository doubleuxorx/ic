/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri expects a fixed dev port. Nothing here may reference a remote origin:
// every asset is bundled locally.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // PDF.js starts its worker with `type: "module"`, so the bundled worker has to
  // be one.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Named because nothing reaches it from an entry point the dev server
    // scans: it is imported by `src/media/pdf-worker.ts`, which the application
    // loads as a worker. Left to discover it when a PDF first opens, vite
    // pre-bundles it then and reloads the page underneath whatever was
    // happening — which is what it did to the self-test on a cold cache.
    include: ['pdfjs-dist/build/pdf.worker.min.mjs'],
  },
  build: {
    target: 'es2022',
    // Debug assets are excluded from release builds.
    sourcemap: false,
    minify: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        // Keep the heavy viewers out of the startup chunk.
        manualChunks: (id: string) => {
          if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs';
          if (id.includes('node_modules/@codemirror')) return 'codemirror';
          if (id.includes('node_modules/@xyflow')) return 'flow';
          return null;
        },
      },
    },
  },
  test: {
    // Per file, so a test of pure functions pays nothing for a DOM. Anything
    // that renders declares `// @vitest-environment jsdom` at the top.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Geometry and observers jsdom lacks, in place before any module loads.
    setupFiles: ['./tests/support/dom-stubs.ts'],
  },
});
