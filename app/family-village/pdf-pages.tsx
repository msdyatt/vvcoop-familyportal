"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
// Self-hosted: Vite emits the worker as one of our own static assets and gives
// back its URL. Nothing is loaded from a CDN, so the page's content security
// policy only needs to allow workers from our own origin.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
};
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void>; cancel: () => void };
};

/**
 * Renders a PDF page by page, each in a box that keeps the page's own shape, so
 * anything positioned inside it in percentages (signature fields) lands in the
 * same place at every screen width.
 *
 * `renderOverlay(pageNumber)` is drawn on top of each page in a layer that
 * covers it exactly. `onPageClick` reports a click as fractions of the page
 * from its top-left corner, which is how fields are stored.
 */
export default function PdfPages({ data, renderOverlay, onPageClick, onLoaded, maxWidth = 900 }: {
  data: Uint8Array | null;
  renderOverlay?: (page: number) => ReactNode;
  /** A click on empty page: where, as fractions from the top-left, and the page's width / height. */
  onPageClick?: (page: number, xFraction: number, yFraction: number, ratio: number) => void;
  onLoaded?: (pageCount: number) => void;
  maxWidth?: number;
}) {
  const [pages, setPages] = useState<{ n: number; ratio: number }[]>([]);
  const [error, setError] = useState("");
  const [rendered, setRendered] = useState(0);
  const canvases = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let doc: PdfDocument | null = null;
    const tasks: { cancel: () => void }[] = [];

    (async () => {
      try {
        setPages([]); setError(""); setRendered(0);
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // pdf.js takes ownership of the buffer it is given, so hand it a copy.
        doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false }).promise as unknown as PdfDocument;
        if (cancelled) return;
        const sizes: { n: number; ratio: number; page: PdfPage }[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const v = page.getViewport({ scale: 1 });
          sizes.push({ n, ratio: v.width / v.height, page });
        }
        if (cancelled) return;
        setPages(sizes.map(({ n, ratio }) => ({ n, ratio })));
        onLoadedRef.current?.(doc.numPages);

        // Wait for the canvases to exist, then paint them one after another.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (const { n, page } of sizes) {
          if (cancelled) return;
          const canvas = canvases.current.get(n);
          if (!canvas) continue;
          const cssWidth = Math.min(canvas.parentElement?.clientWidth || maxWidth, maxWidth);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (cssWidth * dpr) / base.width });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const context = canvas.getContext("2d");
          if (!context) continue;
          const task = page.render({ canvasContext: context, viewport });
          tasks.push(task);
          await task.promise;
          if (!cancelled) setRendered(n);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error && /password/i.test(e.message)
          ? "This PDF is password protected and cannot be shown."
          : "This document could not be shown. Try again, or tell an administrator.");
      }
    })();

    return () => {
      cancelled = true;
      for (const t of tasks) { try { t.cancel(); } catch { /* already finished */ } }
      doc?.destroy().catch(() => undefined);
    };
  }, [data, maxWidth]);

  if (error) return <p className="portal-empty" role="alert">{error}</p>;
  if (!data) return <p className="portal-empty">Loading the document…</p>;

  return <div className="pdf-pages" style={{ maxWidth }}>
    {pages.map(({ n, ratio }) => <div
      key={n}
      className="pdf-page"
      style={{ aspectRatio: String(ratio) }}
      data-page={n}
      data-rendered={rendered >= n ? "true" : "false"}
    >
      <canvas ref={(el) => { if (el) canvases.current.set(n, el); else canvases.current.delete(n); }} aria-label={`Page ${n}`} />
      {/* A click on empty page is for placing a field. The editor offers the same
          action from a button, so this is a convenience for pointer users, not the only way. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="pdf-page-overlay"
        onClick={onPageClick ? (event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onPageClick(n, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height, rect.width / rect.height);
        } : undefined}
      >
        {renderOverlay?.(n)}
      </div>
      <span className="pdf-page-number">Page {n} of {pages.length}</span>
    </div>)}
  </div>;
}

/** SHA-256 and page count of a PDF the browser has just been handed, before it is uploaded. */
export async function readPdfInfo(bytes: Uint8Array): Promise<{ sha256: string; pages: number }> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages = doc.numPages;
  await doc.destroy();
  return { sha256, pages };
}
