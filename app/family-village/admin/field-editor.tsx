"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET } from "../../../lib/storage";
import { FIELD_COLUMNS, friendlyError, type FieldKind, type SignField } from "../../../lib/sign";
import PdfPages from "../pdf-pages";

export type Template = {
  id: string; title: string; storage_path: string; sha256: string; page_count: number;
  signers_required: number; status: "draft" | "ready" | "archived"; created_at: string;
};

type EditorField = {
  key: string; page: number; x: number; y: number; w: number; h: number;
  kind: FieldKind; signer_slot: 1 | 2; required: boolean; label: string;
};

const KINDS: { kind: FieldKind; label: string; w: number; h: number }[] = [
  { kind: "signature", label: "Signature", w: 0.28, h: 0.05 },
  { kind: "initials", label: "Initials", w: 0.1, h: 0.04 },
  { kind: "date", label: "Date", w: 0.18, h: 0.03 },
  { kind: "text", label: "Text", w: 0.32, h: 0.03 },
  { kind: "checkbox", label: "Checkbox", w: 0.03, h: 0.03 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()));

/**
 * Places signature, initials, date, text and checkbox fields anywhere on any
 * page of a PDF. Positions are kept as fractions of the page measured from its
 * top-left corner, so they mean the same thing at every zoom level and in the
 * sealed copy. Each field belongs to signer 1 or signer 2.
 *
 * Everything can be done without dragging: pick a kind and signer, press "Add
 * to page", and move, resize or retype a field from the list on the left.
 */
export default function FieldEditor({ template, locked, onClose, onSaved, pdfBytes }: {
  template: Template; locked: boolean; onClose: () => void; onSaved: () => void;
  /** When the caller already holds the file (for instance straight after an upload), no download is needed. */
  pdfBytes?: Uint8Array;
}) {
  const [pdf, setPdf] = useState<Uint8Array | null>(pdfBytes ?? null);
  const [fields, setFields] = useState<EditorField[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<FieldKind>("signature");
  const [slot, setSlot] = useState<1 | 2>(1);
  const [page, setPage] = useState(1);
  const [title, setTitle] = useState(template.title);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const ratios = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      const [file, existing] = await Promise.all([
        pdfBytes ? Promise.resolve({ data: null }) : supabase.storage.from(PRIVATE_BUCKET).download(template.storage_path),
        supabase.from("sign_fields").select(FIELD_COLUMNS).eq("template_id", template.id).order("page"),
      ]);
      if (cancelled) return;
      if (file.data) setPdf(new Uint8Array(await file.data.arrayBuffer())); else if (!pdfBytes) setMessage("The PDF could not be opened.");
      setFields(((existing.data ?? []) as SignField[]).map((f) => ({
        key: f.id, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, kind: f.kind, signer_slot: f.signer_slot, required: f.required, label: f.label ?? "",
      })));
    })();
    return () => { cancelled = true; };
  }, [template, pdfBytes]);

  const current = fields.find((f) => f.key === selected) ?? null;
  const patch = (key: string, change: Partial<EditorField>) => {
    setFields((all) => all.map((f) => f.key === key ? { ...f, ...change } : f));
    setDirty(true);
  };

  function add(onPage: number, x: number, y: number, ratio: number) {
    if (locked) return;
    const base = KINDS.find((k) => k.kind === kind)!;
    // A checkbox is square on paper, which is not square as fractions of a tall page.
    const w = base.w;
    const h = kind === "checkbox" ? base.w * ratio : base.h;
    const field: EditorField = {
      key: newKey(), page: onPage, x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - h / 2, 0, 1 - h), w, h,
      kind, signer_slot: slot, required: true, label: "",
    };
    setFields((all) => [...all, field]);
    setSelected(field.key);
    setDirty(true);
  }

  function remove(key: string) {
    setFields((all) => all.filter((f) => f.key !== key));
    setSelected(null);
    setDirty(true);
  }

  // Dragging and resizing. The page overlay is the coordinate space.
  const drag = useRef<{ key: string; mode: "move" | "resize"; startX: number; startY: number; orig: EditorField; rect: DOMRect } | null>(null);
  function startDrag(event: React.PointerEvent, field: EditorField, mode: "move" | "resize") {
    if (locked) return;
    event.stopPropagation();
    const overlay = (event.currentTarget as HTMLElement).closest(".pdf-page-overlay") as HTMLElement;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { key: field.key, mode, startX: event.clientX, startY: event.clientY, orig: field, rect: overlay.getBoundingClientRect() };
    setSelected(field.key);
  }
  function moveDrag(event: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (event.clientX - d.startX) / d.rect.width;
    const dy = (event.clientY - d.startY) / d.rect.height;
    if (d.mode === "move") {
      patch(d.key, { x: clamp(d.orig.x + dx, 0, 1 - d.orig.w), y: clamp(d.orig.y + dy, 0, 1 - d.orig.h) });
    } else {
      patch(d.key, { w: clamp(d.orig.w + dx, 0.02, 1 - d.orig.x), h: clamp(d.orig.h + dy, 0.015, 1 - d.orig.y) });
    }
  }

  const pageCount = template.page_count;
  const slotsInUse = useMemo(() => new Set(fields.map((f) => f.signer_slot)), [fields]);
  const problems: string[] = [];
  if (!fields.some((f) => f.kind === "signature" && f.signer_slot === 1)) problems.push("Signer 1 needs a signature field.");
  if (slotsInUse.has(2) && !fields.some((f) => f.kind === "signature" && f.signer_slot === 2)) problems.push("Signer 2 needs a signature field.");

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const payload = fields.map((f) => ({
      page: f.page, x: +f.x.toFixed(5), y: +f.y.toFixed(5), w: +f.w.toFixed(5), h: +f.h.toFixed(5),
      kind: f.kind, slot: f.signer_slot, required: f.required, label: f.label.trim() || null,
    }));
    const { error } = await supabase.rpc("sign_save_fields", { p_template: template.id, p_title: title, p_fields: payload });
    setBusy(false);
    if (error) { setMessage(friendlyError(error)); return; }
    setDirty(false);
    setMessage("Saved.");
    onSaved();
  }

  function overlay(p: number) {
    return fields.filter((f) => f.page === p).map((f) => <div
      key={f.key}
      className={`editor-field slot-${f.signer_slot}${selected === f.key ? " selected" : ""}`}
      style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
      onPointerDown={(e) => startDrag(e, f, "move")}
      onPointerMove={moveDrag}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      role="button" tabIndex={0} aria-label={`${f.kind} for signer ${f.signer_slot} on page ${f.page}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(f.key); } }}
    >
      <span>{f.kind === "text" && f.label ? f.label : KINDS.find((k) => k.kind === f.kind)?.label}<i>{f.signer_slot}</i></span>
      {selected === f.key && !locked && <b className="editor-handle" onPointerDown={(e) => startDrag(e, f, "resize")} onPointerMove={moveDrag}
        onPointerUp={() => { drag.current = null; }} aria-hidden="true" />}
    </div>);
  }

  return <section className="field-editor" aria-label={`Place fields on ${template.title}`}>
    <div className="field-editor-bar">
      <button type="button" className="sign-big secondary compact" onClick={onClose}>← Back to documents</button>
      <label className="field-editor-title"><span className="field-caption">Name</span>
        <input value={title} maxLength={200} disabled={locked} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} /></label>
      {!locked && <button type="button" className="sign-big" disabled={busy || !dirty} onClick={save}>{busy ? "Saving…" : "Save fields"}</button>}
    </div>
    {locked && <p className="admin-form-status" role="status">This document has been sent, so its fields are locked. To change them, duplicate it from the document list.</p>}
    {message && <p className="admin-form-status" role="status">{message}</p>}

    <div className="field-editor-layout">
      <aside className="field-editor-side">
        {!locked && <fieldset className="field-editor-add">
          <legend>Add a field</legend>
          <label><span className="field-caption">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as FieldKind)}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select></label>
          <label><span className="field-caption">For</span>
            <select value={slot} onChange={(e) => setSlot(Number(e.target.value) as 1 | 2)}>
              <option value={1}>Signer 1</option><option value={2}>Signer 2 (only if there is a second adult)</option>
            </select></label>
          <label><span className="field-caption">Page</span>
            <input type="number" min={1} max={pageCount} value={page} onChange={(e) => setPage(clamp(Number(e.target.value) || 1, 1, pageCount))} /></label>
          <button type="button" className="sign-big secondary compact" onClick={() => add(page, 0.5, 0.5, ratios.current.get(page) ?? 0.77)}>Add to page {page}</button>
          <p className="sign-hint">Most documents need only signer 1. Add signer 2 fields only if a second adult should sign too; a household with one adult simply gets signer 1\u2019s fields.</p>
          <p className="sign-hint">Or click anywhere on a page to place one there. Drag to move; drag the corner to resize.</p>
        </fieldset>}

        {current && <fieldset className="field-editor-props">
          <legend>Selected field</legend>
          <label><span className="field-caption">Kind</span>
            <select value={current.kind} disabled={locked} onChange={(e) => patch(current.key, { kind: e.target.value as FieldKind })}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select></label>
          <label><span className="field-caption">Belongs to</span>
            <select value={current.signer_slot} disabled={locked} onChange={(e) => patch(current.key, { signer_slot: Number(e.target.value) as 1 | 2 })}>
              <option value={1}>Signer 1</option><option value={2}>Signer 2 (only if there is a second adult)</option>
            </select></label>
          {(current.kind === "text" || current.kind === "checkbox") && <label><span className="field-caption">Prompt shown to the signer</span>
            <input value={current.label} maxLength={80} disabled={locked} onChange={(e) => patch(current.key, { label: e.target.value })} /></label>}
          {(current.kind === "text" || current.kind === "checkbox") && <label className="checkbox-field">
            <input type="checkbox" checked={current.required} disabled={locked} onChange={(e) => patch(current.key, { required: e.target.checked })} /> Required</label>}
          <div className="field-editor-nudge">
            {(["x", "y", "w", "h"] as const).map((k) => <label key={k}><span className="field-caption">{({ x: "Left %", y: "Top %", w: "Width %", h: "Height %" })[k]}</span>
              <input type="number" step="0.5" min={0} max={100} disabled={locked} value={+(current[k] * 100).toFixed(1)}
                onChange={(e) => {
                  const v = clamp((Number(e.target.value) || 0) / 100, 0, 1);
                  if (k === "x") patch(current.key, { x: clamp(v, 0, 1 - current.w) });
                  else if (k === "y") patch(current.key, { y: clamp(v, 0, 1 - current.h) });
                  else if (k === "w") patch(current.key, { w: clamp(v, 0.02, 1 - current.x) });
                  else patch(current.key, { h: clamp(v, 0.015, 1 - current.y) });
                }} /></label>)}
          </div>
          <label><span className="field-caption">Page</span>
            <input type="number" min={1} max={pageCount} value={current.page} disabled={locked} onChange={(e) => patch(current.key, { page: clamp(Number(e.target.value) || 1, 1, pageCount) })} /></label>
          {!locked && <button type="button" className="sign-big danger compact" onClick={() => remove(current.key)}>Delete field</button>}
        </fieldset>}

        <div className="field-editor-list">
          <b>{fields.length} {fields.length === 1 ? "field" : "fields"}</b>
          <ul>{fields.map((f) => <li key={f.key}>
            <button type="button" className={selected === f.key ? "active" : ""} onClick={() => { setSelected(f.key); setPage(f.page); }}>
              Page {f.page} · {KINDS.find((k) => k.kind === f.kind)?.label} · Signer {f.signer_slot}
            </button>
          </li>)}</ul>
          {problems.map((p) => <p key={p} className="sign-hint" role="status">{p}</p>)}
        </div>
      </aside>

      <div className="field-editor-pages">
        <PdfPages data={pdf} renderOverlay={overlay}
          onPageClick={(p, x, y, ratio) => { ratios.current.set(p, ratio); setPage(p); if (!locked) add(p, x, y, ratio); }} />
      </div>
    </div>
  </section>;
}
