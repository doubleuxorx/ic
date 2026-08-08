/**
 * Shift+wheel on the canvas.
 *
 * Shift+wheel is meant to move the canvas sideways. Two layers agree on that and
 * get it wrong together: WebKitGTK has already moved the delta onto the
 * horizontal axis by the time the event arrives, and React Flow then makes the
 * same move itself, taking a vertical delta that is no longer there. The gesture
 * ends up doing nothing at all.
 *
 * Rather than reimplement panning, the event is corrected before React Flow
 * reads it: the delta goes on the horizontal axis and the modifier is cleared,
 * so React Flow pans it like any other wheel, at the same speed and within the
 * same limits, and reports the move the same way. `deltaMode` is left as it
 * came, because the event itself is kept rather than rebuilt.
 *
 * Nothing here touches the canvas or the event: it decides what the corrected
 * values are, which is what the tests check.
 */

/** The properties to overwrite on the event, in place. */
export interface HorizontalWheel {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
}

/** How to correct this wheel event, or null to leave it alone. */
export const horizontalWheel = (event: WheelEvent): HorizontalWheel | null => {
  if (!event.shiftKey) return null;
  // Ctrl+wheel zooms, and the remaining modifiers are not the canvas's to claim.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  // `nowheel` marks the parts that keep the wheel for themselves — the focused
  // editor, an open PDF — which React Flow reads the same way. There the
  // platform's own scrolling, sideways or not, is the right answer.
  const target = event.target;
  if (target instanceof Element && target.closest('.nowheel')) return null;

  // The delta arrives on whichever axis the engine chose for it, so take it from
  // the one that carries it and put it on the horizontal axis.
  const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
  if (delta === 0) return null;

  // Without the modifier this is an ordinary wheel, which is the point: React
  // Flow's own Shift handling no longer has anything to act on, and the delta
  // stays where it has been put.
  return { deltaX: delta, deltaY: 0, shiftKey: false };
};

/** Apply the correction to the event itself, before anything else reads it. */
export const correctWheel = (event: WheelEvent): void => {
  const corrected = horizontalWheel(event);
  if (!corrected) return;
  // These are accessors on the prototype, so an own property of the same name
  // is what every later listener reads.
  for (const [name, value] of Object.entries(corrected)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
};
