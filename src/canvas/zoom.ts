/**
 * Zoom arithmetic, shared by the canvas and by the views inside its nodes.
 *
 * A node stores its size in canvas units, and the canvas is scaled by a single
 * transform, so a view that rasterizes at the node's size alone is only correct
 * at zoom 1. Shrinking a node and zooming back in must put the document on
 * screen at full size, not magnify the bitmap made for the smaller box, which
 * means every raster view has to know how many device pixels it really covers.
 *
 * Nothing here reads the DOM or the stores: it is the conversion between canvas
 * units and device pixels, and the tests treat it as arithmetic.
 */

/**
 * Canvas zoom limits. The range is wide enough that a page shrunk to a speck
 * still zooms back to full size, and stops where a browser transform starts to
 * lose precision rather than at a round number.
 */
export const MIN_ZOOM = 0.002;
export const MAX_ZOOM = 256;

/** Ratio of device pixels to CSS pixels, clamped: past 2 the cost outruns the gain. */
export const pixelRatio = (): number =>
  Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);

/** Device pixels covered by a length given in canvas units. */
export const screenPixels = (canvasUnits: number, zoom: number): number =>
  canvasUnits * zoom * pixelRatio();

/** Coarsest oversampling worth allocating; beyond this the memory buys nothing. */
const MAX_RENDER_SCALE = 8;
/** Zoomed far out, half of the node's own size is still more detail than is visible. */
const MIN_RENDER_SCALE = 0.5;

/**
 * Multiplier for a raster view rendering at the node's own size, quantized to
 * powers of two so that panning and pinching do not each ask for a slightly
 * different bitmap. It rounds up, so the result is never coarser than the screen.
 */
export const renderScale = (zoom: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  const stepped = 2 ** Math.ceil(Math.log2(zoom));
  return Math.min(Math.max(stepped, MIN_RENDER_SCALE), MAX_RENDER_SCALE);
};

/** Dot spacing in canvas units at zoom 1, and the on-screen range it may drift within. */
const BASE_GAP = 24;
const MIN_SCREEN_GAP = 16;
const MAX_SCREEN_GAP = 128;
const GAP_STEP = 4;

/**
 * Dot grid for the current zoom, in canvas units. The spacing steps by factors
 * of four so the grid keeps a constant density on screen: without it the dots
 * fuse into a grey sheet when zoomed out and drift to the far corners when
 * zoomed in, and the pattern is what tells you the canvas is still moving.
 */
export const backgroundGrid = (zoom: number): { gap: number; size: number } => {
  if (!Number.isFinite(zoom) || zoom <= 0) return { gap: BASE_GAP, size: 1 };
  let gap = BASE_GAP;
  while (gap * zoom < MIN_SCREEN_GAP) gap *= GAP_STEP;
  while (gap * zoom > MAX_SCREEN_GAP) gap /= GAP_STEP;
  // The dot itself is drawn scaled too, so its size is stated in canvas units.
  return { gap, size: 1 / zoom };
};
