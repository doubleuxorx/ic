import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  boundingBox,
  createId,
  nodesInsideGroup,
  normalizeColor,
  parseCanvas,
  serializeCanvas,
  type CanvasDocument,
  type GroupNode,
} from '@/shared/json-canvas';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

describe('JSON Canvas parsing', () => {
  it('reads a canvas produced by another application', () => {
    const document = parseCanvas(fixture('obsidian-sample.canvas'));
    expect(document.nodes).toHaveLength(5);
    expect(document.edges).toHaveLength(2);

    const text = document.nodes.find((node) => node.type === 'text');
    expect(text?.type === 'text' && text.text).toContain('# Heading');
    expect(text?.color).toBe('4');

    const group = document.nodes.find((node) => node.type === 'group') as GroupNode;
    expect(group.label).toBe('Research');
    expect(group.color).toBe('#7b3fbf');
    expect(group.backgroundStyle).toBe('cover');
  });

  it('preserves unknown fields on nodes and at the top level', () => {
    const document = parseCanvas(fixture('obsidian-sample.canvas'));
    const withVendor = document.nodes.find((node) => node.extra !== undefined);
    expect(withVendor?.extra).toEqual({ unknownVendorField: { kept: true } });
    expect(document.extra).toEqual({ vendorMetadata: { preserved: 'yes' } });
  });

  it('round-trips without losing or reordering data', () => {
    const original = fixture('obsidian-sample.canvas');
    const once = serializeCanvas(parseCanvas(original));
    const twice = serializeCanvas(parseCanvas(once));
    expect(twice).toBe(once);

    const reparsed = parseCanvas(once);
    expect(reparsed.nodes.map((node) => node.id)).toEqual(
      parseCanvas(original).nodes.map((node) => node.id),
    );
    // Edge direction, sides, ends, labels and colours survive.
    expect(reparsed.edges[0]).toMatchObject({
      fromSide: 'right',
      toSide: 'left',
      label: 'describes',
      color: '2',
    });
    expect(reparsed.edges[1]).toMatchObject({ fromEnd: 'arrow', toEnd: 'none' });
  });

  it('writes integer geometry', () => {
    const document: CanvasDocument = {
      nodes: [
        { id: 'n1', type: 'text', text: 'x', x: 10.4, y: -3.6, width: 200.5, height: 99.2 },
      ],
      edges: [],
    };
    const written = JSON.parse(serializeCanvas(document));
    expect(written.nodes[0]).toMatchObject({ x: 10, y: -4, width: 201, height: 99 });
  });

  it('drops entries that the specification cannot represent', () => {
    const document = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'ok', type: 'text', text: 'fine', x: 0, y: 0, width: 10, height: 10 },
          { id: 'dupe', type: 'nonsense', x: 0, y: 0, width: 10, height: 10 },
          { id: 'nofile', type: 'file', x: 0, y: 0, width: 10, height: 10 },
        ],
        edges: [
          { id: 'e1', fromNode: 'ok', toNode: 'missing' },
          { id: 'e2', fromNode: 'ok', toNode: 'ok' },
        ],
      }),
    );
    expect(document.nodes.map((node) => node.id)).toEqual(['ok']);
    // The dangling edge is dropped; the self-edge is legal.
    expect(document.edges.map((edge) => edge.id)).toEqual(['e2']);
  });

  it('accepts preset and hex colours only', () => {
    expect(normalizeColor('3')).toBe('3');
    expect(normalizeColor('#ff8800')).toBe('#ff8800');
    expect(normalizeColor('#abc')).toBe('#abc');
    expect(normalizeColor('red')).toBeUndefined();
    expect(normalizeColor('7')).toBeUndefined();
    expect(normalizeColor('javascript:alert(1)')).toBeUndefined();
  });

  it('generates unique identifiers', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createId()));
    expect(ids.size).toBe(500);
  });

  it('resolves group membership geometrically', () => {
    const group: GroupNode = { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100 };
    const document: CanvasDocument = {
      nodes: [
        group,
        { id: 'inside', type: 'text', text: '', x: 10, y: 10, width: 20, height: 20 },
        { id: 'outside', type: 'text', text: '', x: 200, y: 10, width: 20, height: 20 },
        { id: 'overlap', type: 'text', text: '', x: 90, y: 10, width: 40, height: 20 },
      ],
      edges: [],
    };
    expect(nodesInsideGroup(document, group).map((node) => node.id)).toEqual(['inside']);
    expect(boundingBox(document.nodes)).toEqual({ x: 0, y: 0, width: 220, height: 100 });
  });

  it('treats an empty file as an empty canvas', () => {
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [] });
    expect(() => parseCanvas('not json')).toThrow();
  });
});
