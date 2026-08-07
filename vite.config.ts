/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * The commit the bundle was built from, `-dirty` when the tree had uncommitted
 * changes. A build from a source tarball has no repository, so this is allowed
 * to fail and say so rather than break the build.
 */
const commit = (): string => {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '-dirty' : ''}`;
  } catch {
    return 'unknown';
  }
};

// `SOURCE_DATE_EPOCH` is honoured so a release build stays reproducible.
const buildTime = (): string => {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return new Date(Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.now()).toISOString();
};

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
  // What the running application knows about the build it came from. See
  // `src/shared/build-info.ts`.
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_COMMIT__: JSON.stringify(commit()),
    __APP_BUILD_TIME__: JSON.stringify(buildTime()),
  },
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
