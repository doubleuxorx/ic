/**
 * PDF view, built on a locally bundled PDF.js core API and worker.
 *
 * This component renders pages directly to a canvas. It does not instantiate
 * PDF.js's annotation or scripting layers, and XFA rendering is disabled.
 * Documents still drive the PDF parser and image/colour decoders, so resource
 * limits below bound some of the work a hostile document can request.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

// Before PDF.js, which calls methods WebKitGTK does not have yet.
import '@/shared/map-upsert';

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// The worker ships with the application; there is no CDN fallback. It is PDF.js's
// own worker with the same polyfill ahead of it, since a worker has its own globals.
import workerUrl from '@/media/pdf-worker?worker&url';

import { Icon } from '@/canvas/node-types/NodeShell';
import { useCanvasStore } from '@/canvas/canvas-store';
import { pixelRatio, renderScale } from '@/canvas/zoom';
import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import { fileUrl } from '@/workspace/workspace-store';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = './pdfjs/';
const MAX_IMAGE_PIXELS = 16_777_216;
const MAX_CANVAS_PIXELS = 16_777_216;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_PDF_OPERATION_MS = 30_000;

const loadDocument = (relativePath: string) => {
  // Supply the native worker port ourselves so PDF.js cannot silently fall
  // back to running a hostile document's parser on the UI thread.
  const port = new Worker(workerUrl, { type: 'module', name: 'pdfjs' });
  const worker = pdfjs.PDFWorker.create({ port });
  const task = pdfjs.getDocument({
    url: fileUrl(relativePath),
    worker,
    // Locally bundled resources, resolved relative to the application root.
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    iccUrl: `${ASSET_BASE}iccs/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    // Reject individual decoded images above 16 megapixels and ask PDF.js to
    // resize oversized image-conversion canvases before they reach 64 MiB.
    maxImageSize: MAX_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
    // Range loading remains enabled. Streaming must also be disabled for
    // disableAutoFetch to prevent PDF.js from continuing to read unused data.
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
  });
  let destroyed = false;
  const destroy = (urgent = false) => {
    if (destroyed) return;
    destroyed = true;
    // Let PDF.js cancel network/font resources cleanly when the worker responds,
    // but retain an independent termination path for a stuck parser.
    const forceTermination = window.setTimeout(
      () => {
        port.terminate();
        worker.destroy();
      },
      urgent ? 100 : 1000,
    );
    void task
      .destroy()
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(forceTermination);
        worker.destroy();
        port.terminate();
      });
  };
  return { task, destroy };
};

interface DocumentSession {
  pdf: PDFDocumentProxy;
  destroy: (urgent?: boolean) => void;
}

interface Props {
  relativePath: string;
  active: boolean;
  width: number;
  height: number;
  /** What the node draws its contents at; 1 unless the node has been scaled. */
  scale: number;
}

const PdfNodeComponent = ({ relativePath, active, width, height, scale }: Props) => {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const document = useRef<DocumentSession | null>(null);
  const renderTask = useRef<{ generation: number; cancel: () => void } | null>(null);
  const renderGeneration = useRef(0);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // The scale the page is really seen at: the canvas zoom and the node's own
  // scale together. The zoom is read from the store rather than from React
  // Flow's transform, so it settles once a gesture ends instead of asking for a
  // new raster on every frame of a pinch.
  const zoomedTo = useCanvasStore((state) => state.viewport.zoom) * scale;
  const detail = renderScale(zoomedTo);
  // A scaled node lays its contents out at the size they would have had, so the
  // width to fit the page to is the box divided by that scale, not the box.
  const contentWidth = width / scale;

  const render = useCallback(
    async (session: DocumentSession, pageNumber: number, scaleFactor: number) => {
      const target = canvas.current;
      if (!target) return;
      const generation = ++renderGeneration.current;
      const previousTask = renderTask.current;
      renderTask.current = null;
      previousTask?.cancel();
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        if (renderGeneration.current !== generation) return;
        timedOut = true;
        const currentTask = renderTask.current;
        if (currentTask?.generation === generation) {
          renderTask.current = null;
          currentTask.cancel();
        }
        session.destroy(true);
      }, MAX_PDF_OPERATION_MS);

      try {
        const pdfPage = await session.pdf.getPage(
          Math.min(Math.max(pageNumber, 1), session.pdf.numPages),
        );
        if (renderGeneration.current !== generation) return;
        if (timedOut) throw new Error('PDF page rendering timed out');
        const unscaled = pdfPage.getViewport({ scale: 1 });
        if (
          !Number.isFinite(unscaled.width) ||
          !Number.isFinite(unscaled.height) ||
          unscaled.width <= 0 ||
          unscaled.height <= 0
        ) {
          throw new Error('PDF page has invalid dimensions');
        }

        // Fit the width of the node, then apply the user's zoom and the canvas
        // scale the node is seen at, so a page shrunk on the canvas is rendered
        // for the pixels it will really occupy once zoomed into. Clamp both the
        // backing-store dimensions and total pixels before allocating a canvas:
        // those clamps, not the zoom, are the point where a page stops sharpening.
        const fitScale = Math.max(0.1, (Math.max(contentWidth, 17) - 16) / unscaled.width);
        const requestedScale = fitScale * scaleFactor * detail;
        const requestedWidth = unscaled.width * requestedScale;
        const requestedHeight = unscaled.height * requestedScale;
        const ratio = pixelRatio();
        const dimensionScale = Math.min(
          1,
          MAX_CANVAS_DIMENSION / (Math.max(requestedWidth, requestedHeight) * ratio),
        );
        const requestedPixels = requestedWidth * requestedHeight * ratio * ratio;
        const areaScale =
          requestedPixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / requestedPixels) : 1;
        const viewport = pdfPage.getViewport({
          scale: requestedScale * Math.min(dimensionScale, areaScale),
        });

        // The element keeps the size the page occupies on the node, which the
        // extra detail and the clamps above must not change: they decide how
        // many pixels back that box, so a clamped page turns soft rather than
        // shrinking on the canvas.
        target.width = Math.max(1, Math.floor(viewport.width * ratio));
        target.height = Math.max(1, Math.floor(viewport.height * ratio));
        target.style.width = `${Math.max(1, Math.floor(unscaled.width * fitScale * scaleFactor))}px`;
        target.style.height = `${Math.max(1, Math.floor(unscaled.height * fitScale * scaleFactor))}px`;

        const context = target.getContext('2d');
        if (!context) return;
        if (renderGeneration.current !== generation) return;
        const task = pdfPage.render({
          canvas: target,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        renderTask.current = { generation, cancel: () => task.cancel() };
        await task.promise;
      } catch (renderError) {
        // Cancellation and stale failures are expected when the page, zoom,
        // path, or activation state changes.
        if (renderGeneration.current !== generation) return;
        if (timedOut) throw new Error('PDF page rendering timed out');
        throw renderError;
      } finally {
        window.clearTimeout(timeout);
        if (renderTask.current?.generation === generation) renderTask.current = null;
      }
    },
    [contentWidth, detail],
  );

  useEffect(() => {
    let cancelled = false;
    let timedOut = false;
    setError(null);
    let loaded: ReturnType<typeof loadDocument>;
    try {
      loaded = loadDocument(relativePath);
    } catch (loadError) {
      setError(`PDF worker could not start: ${errorMessage(loadError)}`);
      return;
    }
    const { task, destroy } = loaded;
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      setError('PDF loading timed out');
      destroy(true);
    }, MAX_PDF_OPERATION_MS);
    task.promise
      .then(async (pdf) => {
        window.clearTimeout(timeout);
        if (cancelled || timedOut) {
          destroy();
          return;
        }
        const session = { pdf, destroy };
        document.current = session;
        setPageCount(pdf.numPages);
        await render(session, page, active ? zoom : 1);
      })
      .catch((loadError) => {
        if (!cancelled && !timedOut) setError(errorMessage(loadError));
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      renderGeneration.current += 1;
      const currentTask = renderTask.current;
      renderTask.current = null;
      currentTask?.cancel();
      // Release the current document and worker data before loading a
      // replacement or unmounting the node.
      document.current = null;
      destroy();
    };
    // Activation changes the initial zoom, so replace the previous task and
    // render again with the state-specific scale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath, active]);

  useEffect(() => {
    const session = document.current;
    if (session) {
      void render(session, page, zoom).catch((renderError) => {
        if (document.current === session) setError(errorMessage(renderError));
      });
    }
  }, [page, zoom, render, height]);

  if (error) {
    return <div className="placeholder">{error}</div>;
  }

  return (
    <>
      <div className="node-body scroll nowheel" style={{ height: '100%', padding: 8 }}>
        <canvas className="pdf-canvas" ref={canvas} />
      </div>
      {active && pageCount > 0 ? (
        <div className="pdf-page-strip nodrag nopan">
          <button
            type="button"
            className="icon-button"
            title="Previous page"
            aria-label="Previous page"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="chevron-left" />
          </button>
          <span className="time">
            {page} / {pageCount}
          </span>
          <button
            type="button"
            className="icon-button"
            title="Next page"
            aria-label="Next page"
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="chevron-right" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => setZoom((current) => Math.max(0.25, current - 0.25))}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Fit width"
            aria-label="Fit width"
            onClick={() => setZoom(1)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="folder" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => setZoom((current) => Math.min(4, current + 0.25))}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Open externally"
            aria-label="Open externally"
            onClick={() => void ipc.openPath(relativePath).catch(() => undefined)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="external" />
          </button>
        </div>
      ) : null}
    </>
  );
};

export const PdfNode = memo(PdfNodeComponent);
