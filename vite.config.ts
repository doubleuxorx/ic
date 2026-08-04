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
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
