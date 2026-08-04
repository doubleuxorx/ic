/**
 * Copy PDF.js runtime assets into `public/` so they ship with the application.
 *
 * PDF.js loads character maps, standard fonts, colour profiles and WASM image
 * decoders at runtime. They are served only from these local copies; the
 * QuickJS PDF-scripting sandbox is intentionally excluded.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pdfjs-dist');
const target = join(root, 'public', 'pdfjs');

const DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
const EXCLUDED_WASM_ASSETS = new Set(['quickjs-eval.js', 'quickjs-eval.wasm']);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const directory of DIRECTORIES) {
  await cp(join(source, directory), join(target, directory), {
    recursive: true,
    filter: (sourcePath) =>
      directory !== 'wasm' || !EXCLUDED_WASM_ASSETS.has(sourcePath.split(/[\\/]/).at(-1) ?? ''),
  });
}

console.log(`pdf.js assets copied to public/pdfjs (${DIRECTORIES.join(', ')})`);
