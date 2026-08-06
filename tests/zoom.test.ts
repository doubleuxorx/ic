// @vitest-environment jsdom
/**
 * Zoom arithmetic.
 *
 * This is what makes a shrunken node worth zooming into: a view has to know how
 * many device pixels it covers, not how many canvas units it is wide, or the
 * only scale it is ever sharp at is 1. The numbers below are the ones no test
 * that renders can check, because jsdom neither lays out nor paints.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  backgroundGrid,
  renderScale,
  screenPixels,
} from '@/canvas/zoom';

const withPixelRatio = (ratio: number) => {
  Object.defineProperty(window, 'devicePixelRatio', {
    value: ratio,
    configurable: true,
  });
};

afterEach(() => withPixelRatio(1));

describe('detail asked of a raster view', () => {
  it('renders a page for the pixels it covers, not for the box it sits in', () => {
    // A node shrunk to an eighth and zoomed back in is the whole point: the
    // scale it is rendered at has to follow the zoom, not the node.
    expect(renderScale(8)).toBe(8);
    expect(renderScale(4)).toBe(4);
    expect(renderScale(1)).toBe(1);
  });

  it('steps in powers of two, so panning does not re-render at every scale', () => {
    expect(renderScale(1.1)).toBe(2);
    expect(renderScale(1.9)).toBe(2);
    expect(renderScale(2)).toBe(2);
    expect(renderScale(2.1)).toBe(4);
  });

  it('rounds up, so a view is never coarser than the screen it is on', () => {
    for (const zoom of [0.7, 1.3, 3.2, 5.5, 7.9]) {
      expect(renderScale(zoom)).toBeGreaterThanOrEqual(zoom);
    }
  });

  it('stops asking for more once the memory buys nothing visible', () => {
    expect(renderScale(MAX_ZOOM)).toBe(8);
    expect(renderScale(1e6)).toBe(8);
  });

  it('does not render below half size, however far out the canvas is', () => {
    expect(renderScale(0.1)).toBe(0.5);
    expect(renderScale(MIN_ZOOM)).toBe(0.5);
  });

  it('falls back to full size for a zoom that is not a number', () => {
    expect(renderScale(Number.NaN)).toBe(1);
    expect(renderScale(0)).toBe(1);
    expect(renderScale(-2)).toBe(1);
  });
});

describe('canvas units on a real screen', () => {
  it('counts the zoom and the display density together', () => {
    withPixelRatio(2);
    expect(screenPixels(400, 4)).toBe(3200);
  });

  it('ignores density beyond the point it stops being visible', () => {
    withPixelRatio(4);
    expect(screenPixels(100, 1)).toBe(200);
  });

  it('survives a display that reports nothing', () => {
    withPixelRatio(0);
    expect(screenPixels(100, 1)).toBe(100);
  });
});

describe('the dot grid across the zoom range', () => {
  const screenGap = (zoom: number) => backgroundGrid(zoom).gap * zoom;

  it('leaves the spacing alone at rest', () => {
    expect(backgroundGrid(1)).toEqual({ gap: 24, size: 1 });
  });

  it('keeps the dots apart at every zoom the canvas allows', () => {
    // Without this the grid fuses into a grey sheet when zoomed out and the
    // dots drift off the far corners when zoomed in.
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom *= 1.5) {
      expect(screenGap(zoom)).toBeGreaterThanOrEqual(16);
      expect(screenGap(zoom)).toBeLessThanOrEqual(128);
    }
  });

  it('draws a dot of one screen pixel whatever the canvas is scaled by', () => {
    expect(backgroundGrid(0.01).size * 0.01).toBeCloseTo(1);
    expect(backgroundGrid(64).size * 64).toBeCloseTo(1);
  });

  it('falls back to a fixed grid rather than looping on a bad zoom', () => {
    expect(backgroundGrid(0)).toEqual({ gap: 24, size: 1 });
    expect(backgroundGrid(Number.NaN)).toEqual({ gap: 24, size: 1 });
  });
});
