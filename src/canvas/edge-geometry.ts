/**
 * The curve an edge follows, and the direction it travels at each end.
 *
 * React Flow's `getBezierPath` returns the path and nothing else, and an SVG
 * marker can only be oriented by the tangent at the very endpoint. Together
 * those are what left arrowheads sitting askew. The control point is half the
 * gap between the two facing sides of the nodes, so when that gap is small
 * beside the sideways distance the curve is still turning where the head sits:
 * the tangent at the tip points into the node while the line arrives almost
 * along the other axis, and it meets the head's flank instead of its back.
 *
 * An arrowhead is a shape with length, so what it should line up with is the
 * run of curve it covers, not the infinitesimal direction at its tip. The curve
 * itself is unchanged: these are the same control points React Flow computes,
 * reproduced here only so the shape can be sampled.
 */

import type { NodeSide } from '@/shared/json-canvas';

/**
 * Length of an arrowhead, and so also the run of curve its angle is measured
 * over. One number for both, because they have to agree: the head is aimed
 * along the line exactly as far back as it reaches.
 *
 * Keeping it short is what centres the line in the head. The measured
 * direction is a chord, so the line meets it at both ends but bows away in
 * between, and the bow grows with the distance — a long head has the line
 * riding one of its arms instead of running between them.
 */
export const ARROW_LENGTH = 5;

/** Half the width of the head at its open end. */
export const ARROW_SPREAD = 3.4;

export interface Point {
  x: number;
  y: number;
}

/** React Flow's default, so edges keep exactly the shape they had. */
const CURVATURE = 0.25;

/** Which way a side faces, away from the node. */
const NORMAL: Record<NodeSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/**
 * How far the control point sits off the node.
 *
 * Half the gap when the other end is in front, and a gentler curve when it is
 * behind, where half the gap would point the wrong way.
 */
const controlOffset = (distance: number): number =>
  distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);

const controlPoint = (from: Point, to: Point, side: NodeSide): Point => {
  const normal = NORMAL[side];
  const offset = controlOffset(normal.x * (to.x - from.x) + normal.y * (to.y - from.y));
  return { x: from.x + normal.x * offset, y: from.y + normal.y * offset };
};

const pointAt = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
  const u = 1 - t;
  const ka = u * u * u;
  const kb = 3 * u * u * t;
  const kc = 3 * u * t * t;
  const kd = t * t * t;
  return {
    x: ka * a.x + kb * b.x + kc * c.x + kd * d.x,
    y: ka * a.y + kb * b.y + kc * c.y + kd * d.y,
  };
};

const SAMPLES = 32;

/**
 * The direction, in degrees, that the curve travels over its last arrowhead's
 * length — walking back from the end until far enough away to have a direction
 * worth measuring. A curve shorter than that has none, so its straight-line
 * direction stands in.
 */
const approachAngle = (a: Point, b: Point, c: Point, d: Point): number => {
  for (let step = 1; step <= SAMPLES; step += 1) {
    const behind = pointAt(a, b, c, d, 1 - step / SAMPLES);
    const dx = d.x - behind.x;
    const dy = d.y - behind.y;
    if (Math.hypot(dx, dy) >= ARROW_LENGTH) return (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  return (Math.atan2(d.y - a.y, d.x - a.x) * 180) / Math.PI;
};

export interface EdgeCurve {
  path: string;
  /** Where a label sits: the curve at t=0.5, which is near enough its middle. */
  label: Point;
  /** Degrees an arrowhead at that end should be turned by. */
  fromAngle: number;
  toAngle: number;
}

export const edgeCurve = (
  from: Point,
  fromSide: NodeSide,
  to: Point,
  toSide: NodeSide,
): EdgeCurve => {
  const c1 = controlPoint(from, to, fromSide);
  const c2 = controlPoint(to, from, toSide);
  return {
    path: `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`,
    label: {
      x: from.x * 0.125 + c1.x * 0.375 + c2.x * 0.375 + to.x * 0.125,
      y: from.y * 0.125 + c1.y * 0.375 + c2.y * 0.375 + to.y * 0.125,
    },
    // An arrow at the start points back the way the line came, which is the
    // same curve walked from the other end.
    fromAngle: approachAngle(to, c2, c1, from),
    toAngle: approachAngle(from, c1, c2, to),
  };
};
