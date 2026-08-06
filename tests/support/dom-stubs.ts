/**
 * The parts of a browser jsdom does not have, added before anything imports.
 *
 * jsdom implements the DOM but not layout, geometry or graphics, and three
 * dependencies reach for those at import time: React Flow measures its container
 * with a `ResizeObserver`, PDF.js constructs a `DOMMatrix` while its display
 * module loads, and CodeMirror asks elements for their size. Nothing under test
 * depends on the answers, so these return the emptiest thing that keeps the module
 * loading.
 *
 * Loaded through `test.setupFiles`, which runs before a test file's imports —
 * `beforeEach` is already too late for a module that fails while loading.
 */

if (typeof window !== 'undefined') {
  const global = globalThis as unknown as Record<string, unknown>;

  class NoopObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }

  class FlatMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    m11 = 1;
    m12 = 0;
    m21 = 0;
    m22 = 1;
    m41 = 0;
    m42 = 0;
    scaleSelf(): FlatMatrix {
      return this;
    }
    translateSelf(): FlatMatrix {
      return this;
    }
    multiplySelf(): FlatMatrix {
      return this;
    }
    inverse(): FlatMatrix {
      return this;
    }
    transformPoint(point: { x?: number; y?: number } = {}) {
      return { x: point.x ?? 0, y: point.y ?? 0 };
    }
  }

  const emptyRect = (): DOMRect => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  });

  global.ResizeObserver ??= NoopObserver;
  global.IntersectionObserver ??= NoopObserver;
  global.DOMMatrix ??= FlatMatrix;
  global.DOMMatrixReadOnly ??= FlatMatrix;
  global.DOMPoint ??= class {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
  };
  global.Path2D ??= class {
    addPath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };

  Element.prototype.scrollIntoView ??= () => undefined;
  // jsdom throws for an unimplemented context rather than returning null, which
  // is what a caller that cannot draw expects to see.
  HTMLCanvasElement.prototype.getContext ??= () => null;

  // jsdom gives `Range` none of the CSSOM View geometry, and CodeMirror measures
  // its own text by asking a range over a text node for the boxes it occupies.
  // That happens in a `requestAnimationFrame` callback, so the missing method
  // surfaced as an unhandled exception after a test had already passed —
  // whenever the frame beat the editor's teardown. An empty list is a shape
  // CodeMirror already handles: it returns one itself for nodes it cannot
  // measure.
  Range.prototype.getClientRects ??= () => {
    const rects: DOMRect[] = [];
    return Object.assign(rects, { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect ??= () => emptyRect();
}
