/**
 * Generate performance fixtures.
 *
 * Writes canvases of increasing size into `fixtures/performance/` so canvas
 * interaction can be measured against the targets in the plan: responsive
 * input at 500 ordinary nodes, and no full-attachment decoding on open.
 *
 *   node scripts/make-fixtures.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'fixtures', 'performance');

const id = () => randomBytes(8).toString('hex');

const COLUMNS = 20;
const CELL_X = 360;
const CELL_Y = 260;

/**
 * @param {number} nodeCount
 * @param {number} edgeCount
 * @param {{ files?: string[] }} [options]
 */
const build = (nodeCount, edgeCount, options = {}) => {
  const files = options.files ?? [];
  const nodes = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const common = {
      id: id(),
      x: column * CELL_X,
      y: row * CELL_Y,
      width: 300,
      height: 200,
    };
    const file = files[index % Math.max(files.length, 1)];
    if (file && index % 25 === 0) {
      nodes.push({ ...common, type: 'file', file });
    } else {
      nodes.push({
        ...common,
        type: 'text',
        text: `## Node ${index}\n\nOrdinary text node with a short paragraph of content.`,
        ...(index % 6 === 0 ? { color: String((index % 6) + 1) } : {}),
      });
    }
  }

  const edges = [];
  for (let index = 0; index < edgeCount && nodes.length > 1; index += 1) {
    const from = nodes[index % nodes.length];
    const to = nodes[(index * 7 + 3) % nodes.length];
    if (from.id === to.id) continue;
    edges.push({
      id: id(),
      fromNode: from.id,
      fromSide: 'right',
      toNode: to.id,
      toSide: 'left',
      toEnd: 'arrow',
      ...(index % 10 === 0 ? { label: `edge ${index}` } : {}),
    });
  }

  return `${JSON.stringify({ nodes, edges }, null, '\t')}\n`;
};

await mkdir(target, { recursive: true });

const attachments = [
  'Attachments/large-image.png',
  'Attachments/document.pdf',
  'Attachments/clip.mp4',
];

const cases = [
  ['nodes-100.canvas', build(100, 20)],
  ['nodes-500.canvas', build(500, 100)],
  ['nodes-1000.canvas', build(1000, 100)],
  ['edges-1000.canvas', build(300, 1000)],
  ['media.canvas', build(120, 40, { files: attachments })],
];

for (const [name, contents] of cases) {
  await writeFile(join(target, name), contents);
}

console.log(`wrote ${cases.length} performance fixtures to fixtures/performance`);
console.log(
  'media.canvas references files under Attachments/; copy real large images, a PDF and an MP4 there to measure media behaviour.',
);
