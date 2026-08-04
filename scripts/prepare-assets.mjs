/**
 * Copy PDF.js runtime assets into `public/` so they ship with the application.
 *
 * PDF.js loads character maps, standard fonts, colour profiles and its WASM
 * decoders at runtime. Without local copies it would reach for a CDN, which
 * this application never does.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pdfjs-dist');
const target = join(root, 'public', 'pdfjs');

const DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const directory of DIRECTORIES) {
  await cp(join(source, directory), join(target, directory), { recursive: true });
}

console.log(`pdf.js assets copied to public/pdfjs (${DIRECTORIES.join(', ')})`);
