// @vitest-environment jsdom
/**
 * Shift+wheel, all the way through React Flow.
 *
 * `wheel.test.ts` checks the decision; this checks that the decision reaches the
 * viewport — that correcting the event in place is enough for React Flow's own
 * pan handler, which reads the event after this listener has, to move the canvas
 * sideways. The flow here carries the canvas's panning and selection props,
 * because those are what decide which wheel handler React Flow installs.
 */

import { ReactFlow, ReactFlowProvider, type Viewport } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { correctWheel } from '@/canvas/wheel';

import { cleanup, press, render } from './support/render';

const moves: Viewport[] = [];

const Flow = () => {
  const wrapper = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return undefined;
    element.addEventListener('wheel', correctWheel, { capture: true });
    return () =>
      element.removeEventListener('wheel', correctWheel, { capture: true });
  }, []);

  return (
    <ReactFlow
      ref={wrapper}
      nodes={[]}
      edges={[]}
      panOnScroll
      selectionOnDrag
      panOnDrag={[1, 2]}
      selectionKeyCode="Shift"
      onMove={(_, viewport) => moves.push(viewport)}
    />
  );
};

/** As WebKitGTK sends it: Shift held, the delta already moved sideways. */
const shiftWheel = (pane: Element, deltaX: number): void => {
  pane.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX,
      deltaY: -0,
      shiftKey: true,
    }),
  );
};

afterEach(async () => {
  moves.length = 0;
  await cleanup();
});

describe('shift and the wheel, through react flow', () => {
  it('moves the canvas left and right, not up and down', async () => {
    const view = await render(
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>,
    );
    const pane = view.find('.react-flow__pane');

    // React Flow watches for Shift itself, so the key is really held: pressing
    // it re-renders the flow, which is when it decides what a drag would mean.
    await press(document, 'Shift', { shiftKey: true });

    // The first wheel starts the pan and only reports it as a move once the
    // second arrives.
    shiftWheel(pane, 100);
    shiftWheel(pane, 100);

    // Two notches at React Flow's default scroll speed of 0.5.
    expect(moves.at(-1)).toEqual({ x: -100, y: 0, zoom: 1 });
  });
});
