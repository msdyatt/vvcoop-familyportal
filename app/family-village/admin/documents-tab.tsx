"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET } from "../../../lib/storage";
import { friendlyError } from "../../../lib/sign";
import { readPdfInfo } from "../pdf-pages";
import FieldEditor, { Template } from "./field-editor";
import SendPanel from "./send-panel";
import SentList from "./sent-list";
import DocumentStatus from "./document-status";

const MAX_BYTES = 20 * 1024 * 1024;
const COLUMNS = "id,title,storage_path,sha256,page_count,signers_required,status,created_at";

/**
 * Documents for signature: upload a PDF, place fields on it for one or two
 * signers, send it to households, and follow each copy until it is sealed.
 */
export default function DocumentsTab({ actorUserId }: { actorUserId: string }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sentCounts, setSentCounts] = useState<Record<string, number>>({});
  // Which documents are required of every family for the current school year.
  const [required, setRequired] = useState<Record<string, { id: string; active: boolean; due_on: string | null }>>({});
  const [yearLabel, setYearLabel] = useState("");
  const [years, setYears] = useState<{ id: string; label: string; is_current: boolean }[]>([]);
  const [yearId, setYearId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<{ kind: "list" } | { kind: "edit" | "send"; template: Template }>({ kind: "list" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: allYears } = await supabase.from("school_years").select("id,label,is_current").order("label", { ascending: false });
    setYears((allYears ?? []) as { id: string; label: string; is_current: boolean }[]);
    const year = (allYears ?? []).find((y) => y.is_current) ?? null;
    setYearId((chosen) => chosen || year?.id || (allYears ?? [])[0]?.id || "");
    const [t, r, reqs] = await Promise.all([
      supabase.from("sign_templates").select(COLUMNS).neq("status", "archived").order("created_at", { ascending: false }),
      supabase.from("sign_requests").select("template_id").neq("status", "voided"),
      year ? supabase.from("requirements").select("id,sign_template_id,active,due_on").eq("school_year_id", year.id).not("sign_template_id", "is", null)
            : Promise.resolve({ data: [] }),
    ]);
    setYearLabel(year?.label ?? "");
    const map: Record<string, { id: string; active: boolean; due_on: string | null }> = {};
    for (const row of (reqs.data ?? []) as { id: string; sign_template_id: string; active: boolean; due_on: string | null }[]) map[row.sign_template_id] = { id: row.id, active: row.active, due_on: row.due_on };
    setRequired(map);
    setTemplates((t.data ?? []) as Template[]);
    const counts: Record<string, number> = {};
    for (const row of (r.data ?? []) as { template_id: string }[]) counts[row.template_id] = (counts[row.template_id] ?? 0) + 1;
    setSentCounts(counts);
    setLoaded(true);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
  useEffect(() => { load(); }, [load]);

  async function upload(file: File) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setMessage("");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { setMessage("Choose a PDF file."); return; }
    if (file.size > MAX_BYTES) { setMessage("That file is over 20 MB. Please use a smaller PDF."); return; }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { sha256, pages } = await readPdfInfo(bytes);
      const id = crypto.randomUUID();
      const path = `sign/templates/${id}/original.pdf`;
      const stored = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file, { contentType: "application/pdf", upsert: false });
      if (stored.error) throw new Error(stored.error.message);
      const title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled document";
      const { error } = await supabase.rpc("sign_create_template", { p_id: id, p_title: title, p_page_count: pages, p_sha256: sha256 });
      if (error) { await supabase.storage.from(PRIVATE_BUCKET).remove([path]); throw new Error(friendlyError(error)); }
      await load();
      const { data } = await supabase.from("sign_templates").select(COLUMNS).eq("id", id).single();
      if (data) setView({ kind: "edit", template: data as Template });
    } catch (e) {
      setMessage(e instanceof Error && !/password/i.test(e.message) ? e.message : "That PDF could not be read. Is it password protected?");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // A sent document's fields are locked, so changing them means working from a copy.
  async function duplicate(t: Template) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const id = crypto.randomUUID();
    const path = `sign/templates/${id}/original.pdf`;
    const copied = await supabase.storage.from(PRIVATE_BUCKET).copy(t.storage_path, path);
    if (copied.error) { setBusy(false); setMessage("The copy could not be made."); return; }
    const { error } = await supabase.rpc("sign_create_template", { p_id: id, p_title: `${t.title} (copy)`, p_page_count: t.page_count, p_sha256: t.sha256 });
    if (error) { await supabase.storage.from(PRIVATE_BUCKET).remove([path]); setBusy(false); setMessage(friendlyError(error)); return; }
    const { data: fields } = await supabase.from("sign_fields").select("page,x,y,w,h,kind,signer_slot,required,label").eq("template_id", t.id);
    if (fields?.length) {
      await supabase.rpc("sign_save_fields", {
        p_template: id, p_title: null,
        p_fields: fields.map((f) => ({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, kind: f.kind, slot: f.signer_slot, required: f.required, label: f.label })),
      });
    }
    setBusy(false);
    await load();
    setMessage(`Made “${t.title} (copy)”. Its fields can be changed.`);
  }

  /** Marks a document required of every family for this school year (or not). It appears in Compliance and Paperwork by itself. */
  async function setRequiredFor(t: Template, on: boolean, due: string | null) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setMessage("");
    const { error } = await supabase.rpc("sign_set_required", { p_template: t.id, p_required: on, p_due_on: due });
    setMessage(error ? friendlyError(error) : on
      ? `“${t.title}” is now required of every family for ${yearLabel}. It shows in Compliance; send it below when you are ready.`
      : `“${t.title}” is no longer required for ${yearLabel}. Households keep their records.`);
    await load();
  }

  async function archive(t: Template) {
    if (!confirm(`Remove “${t.title}” from the list? Anything already sent keeps working.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("sign_archive_template", { p_template: t.id, p_archived: true });
    setMessage(error ? friendlyError(error) : "");
    await load();
  }

  if (view.kind === "edit") {
    return <FieldEditor template={view.template} locked={(sentCounts[view.template.id] ?? 0) > 0}
      onClose={() => { setView({ kind: "list" }); load(); }} onSaved={load} />;
  }
  if (view.kind === "send") {
    const req = required[view.template.id];
    return <SendPanel template={view.template} requirementId={req?.active ? req.id : null} yearLabel={yearLabel} onClose={() => setView({ kind: "list" })} onSent={(summary) => { setMessage(summary); setView({ kind: "list" }); load(); setRefreshKey((k) => k + 1); }} />;
  }

  return <div className="documents-tab">
    <section>
      <div className="sent-list-head">
        <h2>Documents</h2>
        <div>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <button type="button" className="sign-big" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Working…" : "Upload a PDF"}</button>
        </div>
      </div>
      <p className="sign-hint">Upload a PDF, place signature and other fields on it, tick &ldquo;Required of every family&rdquo; if everyone must sign it this year (it then appears in Compliance), and send it. Families sign inside Family Village, never from an emailed link.{!yearLabel && " Set a current school year under Classes to be able to require documents."}</p>
      {message && <p className="admin-form-status" role="status">{message}</p>}
      {!loaded && <p className="portal-empty">Loading…</p>}
      {loaded && !templates.length && <p className="portal-empty">No documents yet. Upload a PDF to begin.</p>}
      <ul className="sent-rows">
        {templates.map((t) => {
          const sent = sentCounts[t.id] ?? 0;
          return <li key={t.id} className="sent-row">
            <div className="sent-row-main">
              <b>{t.title}</b>
              <span>{t.page_count} {t.page_count === 1 ? "page" : "pages"} · {t.status === "ready" ? t.signers_required === 1 ? "one signer" : "up to two signers" : "fields not finished"}{sent ? ` · sent to ${sent} ${sent === 1 ? "household" : "households"}` : ""}</span>
            </div>
            <span className={`status-pill ${t.status === "ready" ? "signed" : "pending"}`}>{t.status === "ready" ? "Ready to send" : "Draft"}</span>
            {yearLabel && <div className="documents-required">
              <label><input type="checkbox" checked={!!required[t.id]?.active} disabled={busy}
                onChange={(e) => setRequiredFor(t, e.target.checked, required[t.id]?.due_on ?? null)} />
                <b>Required of every family for {yearLabel}</b></label>
              {required[t.id]?.active && <label><span className="field-caption">Due</span>
                <input type="date" defaultValue={required[t.id]?.due_on ?? ""} onBlur={(e) => { if ((e.target.value || null) !== (required[t.id]?.due_on ?? null)) setRequiredFor(t, true, e.target.value || null); }} /></label>}
            </div>}
            <div className="sent-actions">
              <button type="button" className="sign-big secondary compact" onClick={() => setView({ kind: "edit", template: t })}>{sent ? "View fields" : "Place fields"}</button>
              <button type="button" className="sign-big compact" disabled={t.status !== "ready"} onClick={() => setView({ kind: "send", template: t })}>Send</button>
              <button type="button" className="sign-big secondary compact" disabled={busy} onClick={() => duplicate(t)}>Duplicate</button>
              <button type="button" className="sign-big danger compact" onClick={() => archive(t)}>Remove</button>
            </div>
          </li>;
        })}
      </ul>
    </section>
    <section aria-label="Who needs to sign">
      <div className="sent-list-head">
        <h2>Who needs to sign</h2>
        <label><span className="field-caption">School year</span>
          <select value={yearId} onChange={(e) => setYearId(e.target.value)}>
            {years.map((y) => <option key={y.id} value={y.id}>{y.label}{y.is_current ? " (current)" : ""}</option>)}
            {!years.length && <option value="">No school years yet</option>}
          </select></label>
      </div>
      <DocumentStatus actorUserId={actorUserId} yearId={yearId} refreshKey={refreshKey} />
    </section>
    <SentList refreshKey={refreshKey} />
  </div>;
}
