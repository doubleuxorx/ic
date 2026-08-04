import { describe, expect, it } from 'vitest';

import { applyOp, invertOp, pushHistory, emptyHistory, type CanvasOp } from '@/canvas/history';
import type { CanvasDocument } from '@/shared/json-canvas';

const base = (): CanvasDocument => ({
  nodes: [
    { id: 'a', type: 'text', text: 'first', x: 0, y: 0, width: 100, height: 50 },
    { id: 'b', type: 'text', text: 'second', x: 200, y: 0, width: 100, height: 50 },
    { id: 'c', type: 'group', label: 'g', x: -20, y: -20, width: 400, height: 200 },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', toEnd: 'arrow' }],
});

/** Applying an operation and then its inverse must be a no-op. */
const expectRoundTrip = (document: CanvasDocument, op: CanvasOp) => {
  const inverse = invertOp(document, op);
  const applied = applyOp(document, op);
  expect(applyOp(applied, inverse)).toEqual(document);
  return applied;
};

describe('canvas operations', () => {
  it('inverts node insertion and deletion', () => {
    const document = base();
    expectRoundTrip(document, {
      type: 'insert-nodes',
      nodes: [{ id: 'd', type: 'text', text: 'new', x: 0, y: 0, width: 10, height: 10 }],
    });
    expectRoundTrip(document, { type: 'delete-nodes', ids: ['a'] });
  });

  it('restores deleted nodes at their original index with their edges', () => {
    const document = base();
    const op: CanvasOp = { type: 'delete-nodes', ids: ['a'] };
    const applied = applyOp(document, op);
    expect(applied.nodes.map((node) => node.id)).toEqual(['b', 'c']);
    // Edges touching a removed node go with it.
    expect(applied.edges).toHaveLength(0);
    const restored = applyOp(applied, invertOp(document, op));
    expect(restored).toEqual(document);
  });

  it('inverts moves, resizes, colours and text edits', () => {
    const document = base();
    expectRoundTrip(document, {
      type: 'patch-nodes',
      patches: [{ id: 'a', changes: { x: 50, y: 60 } }],
    });
    expectRoundTrip(document, {
      type: 'patch-nodes',
      patches: [{ id: 'b', changes: { width: 300, height: 120 } }],
    });
    expectRoundTrip(document, {
      type: 'patch-nodes',
      patches: [{ id: 'a', changes: { color: '3' } }],
    });
    expectRoundTrip(document, {
      type: 'patch-nodes',
      patches: [{ id: 'a', changes: { text: 'edited' } }],
    });
  });

  it('inverts edge creation, deletion, labels and colours', () => {
    const document = base();
    expectRoundTrip(document, {
      type: 'insert-edges',
      edges: [{ id: 'e2', fromNode: 'b', toNode: 'a' }],
    });
    expectRoundTrip(document, { type: 'delete-edges', ids: ['e1'] });
    expectRoundTrip(document, {
      type: 'patch-edges',
      patches: [{ id: 'e1', changes: { label: 'relates to', color: '5' } }],
    });
  });

  it('inverts z-order changes', () => {
    const document = base();
    const applied = expectRoundTrip(document, { type: 'reorder-nodes', order: ['c', 'b', 'a'] });
    expect(applied.nodes.map((node) => node.id)).toEqual(['c', 'b', 'a']);
  });

  it('inverts batches in the right order', () => {
    const document = base();
    const applied = expectRoundTrip(document, {
      type: 'batch',
      ops: [
        { type: 'patch-nodes', patches: [{ id: 'a', changes: { x: 10 } }] },
        { type: 'delete-nodes', ids: ['b'] },
        {
          type: 'insert-nodes',
          nodes: [{ id: 'z', type: 'text', text: 'z', x: 1, y: 1, width: 5, height: 5 }],
        },
      ],
    });
    expect(applied.nodes.map((node) => node.id)).toEqual(['a', 'c', 'z']);
  });

  it('keeps unmentioned nodes when reordering a subset', () => {
    const applied = applyOp(base(), { type: 'reorder-nodes', order: ['b'] });
    expect(applied.nodes.map((node) => node.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('history stack', () => {
  it('coalesces rapid edits sharing a merge key', () => {
    const now = Date.now();
    let history = emptyHistory();
    history = pushHistory(history, {
      op: { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: 'a' } }] },
      inverse: { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: '' } }] },
      mergeKey: 'text:a',
      at: now,
    });
    history = pushHistory(history, {
      op: { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: 'ab' } }] },
      inverse: { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: 'a' } }] },
      mergeKey: 'text:a',
      at: now + 100,
    });
    expect(history.past).toHaveLength(1);

    // A pause starts a new undo step.
    history = pushHistory(history, {
      op: { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: 'abc' } }] },
      inverse: { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: 'ab' } }] },
      mergeKey: 'text:a',
      at: now + 5000,
    });
    expect(history.past).toHaveLength(2);
  });

  it('undoes a merged entry back to the original state', () => {
    const document: CanvasDocument = {
      nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    };
    const first: CanvasOp = { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: 'a' } }] };
    const afterFirst = applyOp(document, first);
    const second: CanvasOp = {
      type: 'patch-nodes',
      patches: [{ id: 'a', changes: { text: 'ab' } }],
    };
    const afterSecond = applyOp(afterFirst, second);

    let history = emptyHistory();
    const now = Date.now();
    history = pushHistory(history, {
      op: first,
      inverse: invertOp(document, first),
      mergeKey: 'text:a',
      at: now,
    });
    history = pushHistory(history, {
      op: second,
      inverse: invertOp(afterFirst, second),
      mergeKey: 'text:a',
      at: now + 50,
    });

    const entry = history.past[0];
    expect(entry).toBeDefined();
    expect(applyOp(afterSecond, entry!.inverse)).toEqual(document);
  });

  it('clears the redo stack when a new operation is pushed', () => {
    let history = emptyHistory();
    const entry = {
      op: { type: 'delete-nodes', ids: ['a'] } as CanvasOp,
      inverse: { type: 'batch', ops: [] } as CanvasOp,
      at: Date.now(),
    };
    history = { past: [entry], future: [entry] };
    history = pushHistory(history, { ...entry, at: Date.now() + 1 });
    expect(history.future).toHaveLength(0);
  });
});
