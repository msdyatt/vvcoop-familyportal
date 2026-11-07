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

// Character maps and the standard fonts are served from our own /pdfjs folder
// (copied from pdfjs-dist), so PDFs that rely on them draw their text and nothing
// is fetched from anywhere else.
const PDF_OPTIONS = {
  isEvalSupported: false,
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
};

/**
 * Renders a PDF page by page, each in a box that keeps the page's own shape, so
 * anything positioned inside it in percentages (signature fields) lands in the
 * same place at every screen width.
 *
 * Every page draws itself once it is near the screen, and shows a Retry button
 * if drawing fails, so a page is never silently left blank.
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
  const [loaded, setLoaded] = useState<{ doc: PdfDocument; ratios: number[] } | null>(null);
  const [error, setError] = useState("");
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let opened: PdfDocument | null = null;

    (async () => {
      try {
        setLoaded(null); setError("");
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // pdf.js takes ownership of the buffer it is given, so hand it a copy.
        const doc = await pdfjs.getDocument({ data: data.slice(), ...PDF_OPTIONS }).promise as unknown as PdfDocument;
        opened = doc;
        if (cancelled) { doc.destroy().catch(() => undefined); return; }
        const ratios: number[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const v = (await doc.getPage(n)).getViewport({ scale: 1 });
          ratios.push(v.width / v.height);
        }
        if (cancelled) return;
        setLoaded({ doc, ratios });
        onLoadedRef.current?.(doc.numPages);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error && /password/i.test(e.message)
          ? "This PDF is password protected and cannot be shown."
          : "This document could not be shown. Try again, or tell an administrator.");
      }
    })();

    return () => {
      cancelled = true;
      opened?.destroy().catch(() => undefined);
    };
  }, [data]);

  if (error) return <p className="portal-empty" role="alert">{error}</p>;
  if (!data || !loaded) return <p className="portal-empty">Loading the document…</p>;

  return <div className="pdf-pages" style={{ maxWidth }}>
    {loaded.ratios.map((ratio, i) => <PageView
      key={i + 1} doc={loaded.doc} n={i + 1} total={loaded.ratios.length} ratio={ratio} maxWidth={maxWidth}
      overlay={renderOverlay?.(i + 1)} onPageClick={onPageClick}
    />)}
  </div>;
}

function PageView({ doc, n, total, ratio, maxWidth, overlay, onPageClick }: {
  doc: PdfDocument; n: number; total: number; ratio: number; maxWidth: number;
  overlay: ReactNode;
  onPageClick?: (page: number, x: number, y: number, ratio: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [state, setState] = useState<"waiting" | "drawn" | "failed">("waiting");
  const [attempt, setAttempt] = useState(0);

  // Draw only when the page is close to the screen. A long handbook is not drawn
  // all at once, and a page that scrolls into view is drawn when it gets there.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "900px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(n);
        const c = canvas.current;
        if (!c || cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = Math.min(wrap.current?.clientWidth || maxWidth, maxWidth);
        const base = page.getViewport({ scale: 1 });
        // Keep the bitmap to a size every browser (iOS especially) will allocate.
        const scale = Math.min((cssWidth * dpr) / base.width, Math.sqrt(8_000_000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        const context = c.getContext("2d");
        if (!context) throw new Error("no canvas");
        const rendering = page.render({ canvasContext: context, viewport });
        task = rendering;
        await rendering.promise;
        if (!cancelled) setState("drawn");
      } catch (e) {
        if (cancelled || (e as { name?: string })?.name === "RenderingCancelledException") return;
        console.warn(`Page ${n} could not be drawn`, e);
        setState("failed");
      }
    })();
    return () => { cancelled = true; try { task?.cancel(); } catch { /* already finished */ } };
  }, [near, doc, n, attempt, maxWidth]);

  return <div ref={wrap} className="pdf-page" style={{ aspectRatio: String(ratio) }} data-page={n} data-rendered={state === "drawn" ? "true" : "false"}>
    <canvas ref={canvas} aria-label={`Page ${n}`} />
    {state === "failed" && <div className="pdf-page-failed" role="alert">
      <p>This page could not be drawn.</p>
      <button type="button" className="sign-big" onClick={() => { setState("waiting"); setAttempt((a) => a + 1); }}>Try again</button>
    </div>}
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
      {overlay}
    </div>
    <span className="pdf-page-number">Page {n} of {total}</span>
  </div>;
}

/** SHA-256 and page count of a PDF the browser has just been handed, before it is uploaded. */
export async function readPdfInfo(bytes: Uint8Array): Promise<{ sha256: string; pages: number }> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), ...PDF_OPTIONS }).promise;
  const pages = doc.numPages;
  await doc.destroy();
  return { sha256, pages };
}
