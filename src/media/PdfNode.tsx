/**
 * PDF view, built on a locally bundled PDF.js.
 *
 * Inactive nodes render a single page thumbnail; the heavier document is only
 * kept while the node is active and is destroyed as soon as it is not, which
 * bounds memory on canvases holding many documents. PDF.js runs no document
 * scripting and XFA forms are off, so a hostile document has no execution path.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// The worker ships with the application; there is no CDN fallback.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { Icon } from '@/canvas/node-types/NodeShell';
import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import { fileUrl } from '@/workspace/workspace-store';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = './pdfjs/';

const loadDocument = (relativePath: string) =>
  pdfjs.getDocument({
    url: fileUrl(relativePath),
    // Locally bundled resources, resolved relative to the application root.
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    iccUrl: `${ASSET_BASE}iccs/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    // PDF.js 6 executes no document script and uses no `eval`; XFA forms and
    // pre-fetching stay off so a document cannot drive extra work.
    disableAutoFetch: true,
    disableStream: false,
    enableXfa: false,
  });

interface Props {
  relativePath: string;
  active: boolean;
  width: number;
  height: number;
}

const PdfNodeComponent = ({ relativePath, active, width, height }: Props) => {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const document = useRef<PDFDocumentProxy | null>(null);
  const renderTask = useRef<{ cancel: () => void } | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const render = useCallback(
    async (pdf: PDFDocumentProxy, pageNumber: number, scaleFactor: number) => {
      const target = canvas.current;
      if (!target) return;
      const pdfPage = await pdf.getPage(Math.min(Math.max(pageNumber, 1), pdf.numPages));
      const unscaled = pdfPage.getViewport({ scale: 1 });
      // Fit the width of the node, then apply the user's zoom.
      const fitScale = Math.max(0.1, (width - 16) / unscaled.width);
      const viewport = pdfPage.getViewport({ scale: fitScale * scaleFactor });

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      target.style.width = `${Math.floor(viewport.width)}px`;
      target.style.height = `${Math.floor(viewport.height)}px`;

      const context = target.getContext('2d');
      if (!context) return;
      renderTask.current?.cancel();
      const task = pdfPage.render({
        canvas: target,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTask.current = task;
      await task.promise.catch(() => undefined);
      renderTask.current = null;
    },
    [width],
  );

  useEffect(() => {
    let cancelled = false;
    const task = loadDocument(relativePath);
    task.promise
      .then(async (pdf) => {
        if (cancelled) {
          void task.destroy();
          return;
        }
        document.current = pdf;
        setPageCount(pdf.numPages);
        await render(pdf, page, active ? zoom : 1);
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError));
      });

    return () => {
      cancelled = true;
      renderTask.current?.cancel();
      // Destroying the loading task unloads the document and its worker data,
      // which is what bounds memory on canvases holding many PDFs.
      document.current = null;
      void task.destroy();
    };
    // Re-loading on activation is intentional: the document is unloaded when
    // the node goes inactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath, active]);

  useEffect(() => {
    const pdf = document.current;
    if (pdf) void render(pdf, page, zoom);
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
