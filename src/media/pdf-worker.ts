/**
 * The PDF.js worker as the application ships it: PDF.js's own worker, unmodified,
 * with the `Map` upsert polyfill loaded ahead of it.
 *
 * The worker is a separate script with its own global scope, so a polyfill
 * installed in the window does not reach it. Wrapping the import here keeps the
 * vendored asset untouched — this file is the only thing added to it.
 */

import '@/shared/map-upsert';

import 'pdfjs-dist/build/pdf.worker.min.mjs';
