// @vitest-environment jsdom

/**
 * Guards the two feedback loops that made the window go blank.
 *
 * Both had the same shape: a value owned by one side was mirrored by the other
 * and then written back, so any momentary disagreement replayed forever until
 * React gave up with "maximum update depth exceeded" and unmounted everything.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/canvas/canvas-store';
import { toFlowEdges, toFlowNodes } from '@/canvas/canvas-adapter';
import type { CanvasDocument } from '@/shared/json-canvas';

const document: CanvasDocument = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'a' },
    { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'b' },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
};

describe('selection ownership', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      selection: [],
      selectedEdges: [],
      selectionRequest: null,
    });
  });

  it('ignores a report that repeats the current selection', () => {
    const store = useCanvasStore.getState();
    store.reportSelection(['a'], []);
    const afterFirst = useCanvasStore.getState().selection;

    // React Flow re-reports the same selection whenever its nodes are
    // replaced. Adopting an equal-but-new array would re-render everything
    // that derives from it, which is what drove the loop.
    store.reportSelection(['a'], []);
    expect(useCanvasStore.getState().selection).toBe(afterFirst);
  });

  it('adopts a report that genuinely differs', () => {
    const store = useCanvasStore.getState();
    store.reportSelection(['a'], []);
    store.reportSelection(['a', 'b'], ['e']);
    expect(useCanvasStore.getState().selection).toEqual(['a', 'b']);
    expect(useCanvasStore.getState().selectedEdges).toEqual(['e']);
  });

  it('never raises a request when only reporting', () => {
    useCanvasStore.getState().reportSelection(['a'], []);
    expect(useCanvasStore.getState().selectionRequest).toBeNull();
  });

  it('raises a distinct request each time a command asks', () => {
    const store = useCanvasStore.getState();
    store.setSelection(['a']);
    const first = useCanvasStore.getState().selectionRequest;
    store.setSelection(['a']);
    const second = useCanvasStore.getState().selectionRequest;

    expect(first).not.toBeNull();
    // A repeated ask must still reach the canvas, so identity has to change.
    expect(second).not.toBe(first);
    expect(second?.ids).toEqual(['a']);
  });
});

describe('adapter output', () => {
  it('leaves selection out of the nodes it builds', () => {
    useCanvasStore.getState().reportSelection(['a'], ['e']);
    const nodes = toFlowNodes(document, { activeNodeId: null });
    const edges = toFlowEdges(document);

    // Deriving `selected` from the store would reintroduce the loop: the
    // canvas would overwrite React Flow, which would report the overwrite
    // back. `CanvasView` carries the existing flags across instead.
    expect(nodes.every((node) => node.selected === false)).toBe(true);
    expect(edges.every((edge) => edge.selected === false)).toBe(true);
  });

  it('marks only the active node, and keeps it undraggable', () => {
    const nodes = toFlowNodes(document, { activeNodeId: 'b' });
    expect(nodes.map((node) => node.data.active)).toEqual([false, true]);
    expect(nodes.map((node) => node.draggable)).toEqual([true, false]);
  });
});
