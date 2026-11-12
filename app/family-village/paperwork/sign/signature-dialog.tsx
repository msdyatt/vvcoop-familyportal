"use client";

import { useEffect, useRef, useState } from "react";
import DetailModal from "../../detail-modal";
import type { Mark } from "../../../../lib/sign";

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 4).toUpperCase();
}

/**
 * Adopting a signature or initials: typed, or drawn with a finger or mouse.
 * What is shown here is what gets stamped on the PDF. The typed form is set in
 * the same italic serif the sealed copy uses.
 */
export default function SignatureDialog({ kind, defaultName, onAdopt, onCancel }: {
  kind: "signature" | "initials";
  defaultName: string;
  onAdopt: (mark: Mark) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"type" | "draw">("type");
  const [text, setText] = useState(kind === "signature" ? defaultName : initialsOf(defaultName));
  const [hasInk, setHasInk] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const noun = kind === "signature" ? "signature" : "initials";

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Ink for paper: navy in both themes. The drawing is stamped onto a white PDF page, so it must never take the
    // page's text colour (cream in the dark theme).
    ctx.strokeStyle = "#0b2a3d";
  }, [mode]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvas.current!;
    const rect = c.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * c.width, y: ((event.clientY - rect.top) / rect.height) * c.height };
  }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
    setHasInk(true);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const p = point(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function clear() {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
  }
  function adopt() {
    if (mode === "type") {
      const t = text.trim();
      if (t) onAdopt({ kind: "typed", text: t });
      return;
    }
    const c = canvas.current;
    if (!c || !hasInk) return;
    onAdopt({ kind: "drawn", png: c.toDataURL("image/png").replace(/^data:image\/png;base64,/, "") });
  }

  return <DetailModal title={kind === "signature" ? "Add your signature" : "Add your initials"} onClose={onCancel}>
    <div className="sign-dialog">
      <div className="sign-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "type"} className={mode === "type" ? "active" : ""} onClick={() => setMode("type")}>Type</button>
        <button type="button" role="tab" aria-selected={mode === "draw"} className={mode === "draw" ? "active" : ""} onClick={() => setMode("draw")}>Draw</button>
      </div>
      {mode === "type" ? <>
        <label className="field-caption">Type your {noun}
          <input type="text" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="sign-preview"><span className="sign-typed">{text || " "}</span></div>
      </> : <>
        <p className="sign-hint">Draw your {noun} with your finger or mouse.</p>
        <canvas ref={canvas} className="sign-pad" width={600} height={kind === "signature" ? 200 : 160}
          onPointerDown={start} onPointerMove={move} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }}
          aria-label={`Draw your ${noun} here`} />
        <button type="button" className="sign-big secondary compact" onClick={clear}>Clear</button>
      </>}
      <p className="sign-hint">By adopting this, you accept it as your legal {noun} on this document.</p>
      <div className="sign-dialog-actions">
        <button type="button" className="sign-big secondary compact" onClick={onCancel}>Cancel</button>
        <button type="button" className="sign-big" onClick={adopt} disabled={mode === "type" ? !text.trim() : !hasInk}>Adopt {noun}</button>
      </div>
    </div>
  </DetailModal>;
}
