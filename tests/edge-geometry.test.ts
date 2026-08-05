import { describe, expect, it } from 'vitest';

import { ARROW_LENGTH, edgeCurve } from '@/canvas/edge-geometry';

describe('edgeCurve', () => {
  it('puts the control points where React Flow does', () => {
    // Facing sides 100 apart, so each control point sits half that off its node.
    const curve = edgeCurve({ x: 0, y: 0 }, 'bottom', { x: 200, y: 100 }, 'top');
    expect(curve.path).toBe('M0,0 C0,50 200,50 200,100');
  });

  it('curves gently instead of backwards when the other end is behind', () => {
    // The target is above a bottom-facing side: half the gap would point away
    // from it, so the offset comes from the square root rule instead.
    const curve = edgeCurve({ x: 0, y: 0 }, 'bottom', { x: 100, y: -64 }, 'top');
    expect(curve.path).toBe('M0,0 C0,50 100,-114 100,-64');
  });

  it('places the label on the curve, not on the straight line between the ends', () => {
    const curve = edgeCurve({ x: 0, y: 0 }, 'bottom', { x: 200, y: 100 }, 'top');
    expect(curve.label).toEqual({ x: 100, y: 50 });
  });

  it('points an arrow straight along a drop with no sideways offset', () => {
    const curve = edgeCurve({ x: 0, y: 0 }, 'bottom', { x: 0, y: 300 }, 'top');
    expect(curve.toAngle).toBeCloseTo(90, 5);
    // The arrow at the start faces back the way the line came.
    expect(curve.fromAngle).toBeCloseTo(-90, 5);
  });

  /**
   * The case the whole module exists for. With little room between the facing
   * sides, the curve is still turning where the head sits: its tangent at the
   * endpoint points straight down while the line arrives almost sideways.
   * Measuring across the head's length follows the line instead.
   */
  it('follows the line, not the tangent, when the gap is small beside the offset', () => {
    const curve = edgeCurve({ x: 0, y: 0 }, 'bottom', { x: 240, y: 32 }, 'top');
    // The tangent at the end is straight down. Anything short of that is the
    // head having been turned towards the line instead.
    expect(curve.toAngle).toBeLessThan(85);
    expect(curve.toAngle).toBeGreaterThan(0);
  });

  it('uses the straight line between the ends when the curve is shorter than the head', () => {
    // Three-four-five, scaled to sit well inside one arrowhead's length.
    const scale = (ARROW_LENGTH * 0.6) / 5;
    const to = { x: 3 * scale, y: 4 * scale };
    const curve = edgeCurve({ x: 0, y: 0 }, 'bottom', to, 'top');
    expect(curve.toAngle).toBeCloseTo((Math.atan2(4, 3) * 180) / Math.PI, 5);
  });

  it('turns with the side an edge leaves from', () => {
    const right = edgeCurve({ x: 0, y: 0 }, 'right', { x: 300, y: 0 }, 'left');
    expect(right.path).toBe('M0,0 C150,0 150,0 300,0');
    expect(right.toAngle).toBeCloseTo(0, 5);
    expect(right.fromAngle).toBeCloseTo(180, 5);
  });
});
