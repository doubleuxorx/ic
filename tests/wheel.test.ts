// @vitest-environment jsdom
/**
 * Shift+wheel on the canvas.
 *
 * The gesture reaches the app in two shapes — the delta still vertical, or
 * already moved sideways by the engine — and both have to come out as a
 * horizontal scroll, since a plain wheel already covers up and down. What the
 * canvas does with the corrected event is React Flow's, and is checked in
 * `canvas-wheel.test.tsx`; what is corrected, and what is left alone, is
 * checked here.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { horizontalWheel } from '@/canvas/wheel';

const target = (className = ''): Element => {
  const host = document.createElement('div');
  host.className = className;
  const child = document.createElement('span');
  host.append(child);
  document.body.append(host);
  return child;
};

/** A wheel event with a real target, which is what the `nowheel` check reads. */
const wheel = (element: Element, init: WheelEventInit): WheelEvent => {
  const event = new WheelEvent('wheel', { bubbles: true, ...init });
  element.dispatchEvent(event);
  return event;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shift and the wheel', () => {
  it('keeps a delta the engine already moved sideways on the horizontal axis', () => {
    // What WebKitGTK sends: the delta moved sideways, and a negative zero left
    // on the axis it came from.
    const corrected = horizontalWheel(
      wheel(target(), { shiftKey: true, deltaX: 64, deltaY: -0 }),
    );

    expect(corrected).toEqual({ deltaX: 64, deltaY: 0, shiftKey: false });
  });

  it('takes the delta from the vertical axis when the engine left it there', () => {
    const corrected = horizontalWheel(
      wheel(target(), { shiftKey: true, deltaY: 120 }),
    );

    expect(corrected).toEqual({ deltaX: 120, deltaY: 0, shiftKey: false });
  });

  it('clears the modifier, so nothing downstream moves the delta a second time', () => {
    const corrected = horizontalWheel(
      wheel(target(), { shiftKey: true, deltaY: 120 }),
    );

    expect(corrected?.shiftKey).toBe(false);
  });

  it('leaves a plain wheel alone, which is what scrolls up and down', () => {
    expect(horizontalWheel(wheel(target(), { deltaY: 120 }))).toBeNull();
  });

  it('leaves the zoom gesture alone', () => {
    expect(
      horizontalWheel(wheel(target(), { shiftKey: true, ctrlKey: true, deltaY: 5 })),
    ).toBeNull();
    expect(
      horizontalWheel(wheel(target(), { shiftKey: true, metaKey: true, deltaY: 5 })),
    ).toBeNull();
  });

  it('leaves the wheel to whatever kept it for itself', () => {
    // The focused editor and an open PDF carry `nowheel`, and there the
    // platform's own scrolling is the right answer.
    expect(
      horizontalWheel(wheel(target('nowheel'), { shiftKey: true, deltaY: 120 })),
    ).toBeNull();
  });

  it('corrects nothing for a gesture that carries no delta', () => {
    expect(horizontalWheel(wheel(target(), { shiftKey: true }))).toBeNull();
  });
});
