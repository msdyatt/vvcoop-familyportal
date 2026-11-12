"use client";

import dynamic from "next/dynamic";
import { FormEvent, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, uploadPrivateFile } from "../../../lib/storage";
import DetailModal from "../detail-modal";
import { ClassPageData, DocumentRow } from "./class-data";

// The PDF reader is large and only needed once someone opens a file.
const DocumentViewer = dynamic(() => import("../document-viewer"), { ssr: false });

const SEARCH_FROM = 8;

/** "PDF", "DOC", "IMG" ... from the stored name, so a long list is easy to scan. */
export function fileTypeLabel(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") return "PDF";
  if (["doc", "docx", "pages", "rtf", "txt"].includes(extension)) return "DOC";
  if (["xls", "xlsx", "csv", "numbers"].includes(extension)) return "XLS";
  if (["ppt", "pptx", "key"].includes(extension)) return "PPT";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(extension)) return "IMG";
  return "FILE";
}

function addedOn(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A file name turned into a starting title: "week_4-spelling.pdf" becomes "week 4 spelling". */
function titleFromName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

/**
 * The class's files.
 *
 * Handouts are for the teachers and the families of enrolled children; teacher
 * resources (curriculum) are for the teaching team only. Newest first inside each
 * group. Lead teachers add and remove files; assistants and parents read. The
 * database enforces all of this; the page only hides what a person cannot use.
 */
export default function ClassDocuments({ data, userId, onChanged }: { data: ClassPageData; userId: string; onChanged: () => void }) {
  const canManage = data.isLead || data.isAdmin;
  const onTeam = data.isLead || data.isAssistant || data.isAdmin;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<DocumentRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.documents.filter((doc) => !needle || doc.title.toLowerCase().includes(needle));
  }, [data.documents, query]);
  const handouts = visible.filter((doc) => doc.kind !== "curriculum");
  const resources = visible.filter((doc) => doc.kind === "curriculum");

  async function remove(doc: DocumentRow) {
    if (!confirm(`Remove "${doc.title}"? ${doc.kind === "curriculum" ? "It" : "Families and teachers"} will no longer see it.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setStatus("");
    // The stored file goes first, while the row that proves who may delete it still exists.
    await supabase.storage.from(PRIVATE_BUCKET).remove([doc.storagePath]);
    const { data: removed, error } = await supabase.from("documents").delete().eq("id", doc.id).select("id");
    if (error || !removed?.length) { setStatus(error?.message ?? "Only a lead teacher can remove this file."); return; }
    setStatus(`Removed "${doc.title}".`);
    onChanged();
  }

  return <>
    <div className="cls-panel-head">
      <h3 className="cls-section-title">Class documents</h3>
      {canManage && !adding && <button type="button" className="cls-btn small" onClick={() => setAdding(true)}>Add a file</button>}
    </div>

    {canManage && adding && <AddFile klassId={data.klass.id} userId={userId} onClose={() => setAdding(false)} onAdded={(message) => { setStatus(message); onChanged(); }} />}
    {!canManage && data.isAssistant && <p className="cls-note">The lead teacher adds and removes files for {data.klass.title}.</p>}

    {data.documents.length >= SEARCH_FROM && <input className="cls-search" type="search" placeholder="Search files" aria-label="Search files" value={query} onChange={(event) => setQuery(event.target.value)} />}

    <FileGroup title="Handouts" note={onTeam ? "Visible to teachers and to families of enrolled children." : undefined} docs={handouts}
      empty={data.documents.some((doc) => doc.kind !== "curriculum") ? "No handouts match your search." : onTeam ? (canManage ? "No handouts yet. Add one and families can open it here." : "No handouts yet.") : "No handouts have been shared yet. When the teacher adds one it will appear here."}
      onOpen={setOpen} onRemove={canManage ? remove : undefined} />

    {onTeam && <FileGroup title="Teacher resources" note="Only the teaching team sees these." docs={resources}
      empty={data.documents.some((doc) => doc.kind === "curriculum") ? "No resources match your search." : canManage ? "No teacher resources yet. Curriculum and lesson plans you add here stay private to the teaching team." : "No teacher resources yet."}
      onOpen={setOpen} onRemove={canManage ? remove : undefined} />}

    <p className="cls-status" role="status">{status}</p>

    {open && <DetailModal title={open.title} onClose={() => setOpen(null)}>
      <p className="cls-viewer-meta">{open.kind === "curriculum" ? "Teacher resource" : "Handout"} · added {addedOn(open.createdAt)}</p>
      <DocumentViewer path={open.storagePath} title={open.title} />
    </DetailModal>}
  </>;
}

function FileGroup({ title, note, docs, empty, onOpen, onRemove }: {
  title: string; note?: string; docs: DocumentRow[]; empty: string; onOpen: (doc: DocumentRow) => void; onRemove?: (doc: DocumentRow) => void;
}) {
  return <section aria-label={title}>
    <p className="cls-subhead">{title}{docs.length ? ` (${docs.length})` : ""}</p>
    {note && <p className="cls-note">{note}</p>}
    {docs.length
      ? <ul className="cls-rows">{docs.map((doc) => <li key={doc.id} className="cls-row">
          <span className="cls-filetype" aria-hidden="true">{fileTypeLabel(doc.storagePath)}</span>
          <div className="cls-row-main">
            <span className="cls-row-title">{doc.title}</span>
            <span className="cls-row-sub">Added {addedOn(doc.createdAt)}</span>
          </div>
          <div className="cls-row-actions">
            <button type="button" className="cls-btn quiet small" onClick={() => onOpen(doc)} aria-label={`Open ${doc.title}`}>Open</button>
            {onRemove && <button type="button" className="cls-btn remove small" onClick={() => onRemove(doc)} aria-label={`Remove ${doc.title}`}>Remove</button>}
          </div>
        </li>)}</ul>
      : <p className="cls-note">{empty}</p>}
  </section>;
}

function AddFile({ klassId, userId, onClose, onAdded }: { klassId: string; userId: string; onClose: () => void; onAdded: (message: string) => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"handout" | "curriculum">("handout");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setProblem("");
    const uploaded = await uploadPrivateFile(supabase, "handouts", file);
    if ("error" in uploaded) { setProblem(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("documents").insert({
      class_id: klassId, kind, title: title.trim(), storage_path: uploaded.path, uploaded_by_user_id: userId,
    });
    setBusy(false);
    if (error) { setProblem(error.message); return; }
    onAdded(kind === "curriculum" ? "Added to teacher resources." : "Added. Families of enrolled children can open it now.");
    onClose();
  }

  return <form className="cls-form" onSubmit={submit}>
    <label className="cls-field"><span>File</span>
      <input required type="file" disabled={busy}
        onChange={(event) => {
          const chosen = event.target.files?.[0] ?? null;
          setFile(chosen);
          if (chosen && !title.trim()) setTitle(titleFromName(chosen.name));
        }} />
    </label>
    <label className="cls-field"><span>Title</span>
      <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Week 4 spelling list" disabled={busy} />
    </label>
    <fieldset className="cls-radios" disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="cls-section-title" style={{ marginBottom: 8 }}>Who can open it</legend>
      <label className="cls-radio"><input type="radio" name="kind" checked={kind === "handout"} onChange={() => setKind("handout")} />
        <span><b>Families and teachers</b><small>A handout: parents of enrolled children see it too.</small></span></label>
      <label className="cls-radio"><input type="radio" name="kind" checked={kind === "curriculum"} onChange={() => setKind("curriculum")} />
        <span><b>Teachers only</b><small>Curriculum or lesson plans for the teaching team.</small></span></label>
    </fieldset>
    <div className="cls-actions">
      <button className="cls-btn" disabled={busy || !file || !title.trim()}>{busy ? "Uploading…" : "Add file"}</button>
      <button type="button" className="cls-btn quiet" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
    {problem && <p className="cls-status bad" role="alert">{problem}</p>}
  </form>;
}
