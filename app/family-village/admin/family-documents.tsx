"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../../lib/storage";

type DocRow = { id: string; title: string; kind: string; storage_path: string | null; created_at: string };

/**
 * One household's own documents.
 *
 * This used to be a whole Documents tab. Once required paperwork moved to
 * Compliance, the only thing left that tab did was ad-hoc files for a single
 * household -- which belongs on that household, where an administrator is
 * already looking, rather than in a separate list they have to cross-reference.
 */
export default function FamilyDocuments({ familyId, familyName }: { familyId: string; familyName: string }) {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("form");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("documents")
      .select("id,title,kind,storage_path,created_at")
      .eq("family_id", familyId).order("created_at", { ascending: false });
    setDocs((data ?? []) as DocRow[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- refetches when the household changes; load() is stable in practice and listing it would refetch every render
  useEffect(() => { load(); }, [familyId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "documents", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { data: user } = await supabase.auth.getUser();
    const { error } = await supabase.from("documents").insert({
      family_id: familyId, kind: kind.trim() || "form", title: title.trim(),
      storage_path: uploaded.path, uploaded_by_user_id: user.user?.id,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setAdding(false);
    await load();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}" from the ${familyName} household? This cannot be undone.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("documents").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    await load();
  }

  async function open(path: string | null) {
    if (!path) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return <div className="record-section">
    <p className="card-kicker">Documents</p>
    <p className="field-note">Files for this household only. Anything every family must sign belongs in Compliance.</p>

    {docs.map((doc) => <div className="child-line" key={doc.id}>
      <b>{doc.title}</b>
      <span>{doc.kind} · {new Date(doc.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</span>
      <div className="row-actions">
        {doc.storage_path && <button onClick={() => open(doc.storage_path)}>Open</button>}
        <button className="danger" onClick={() => remove(doc.id, doc.title)}>Delete</button>
      </div>
    </div>)}
    {!docs.length && <p className="portal-empty">No documents for this household.</p>}

    {!adding
      ? <button className="add-child-button" onClick={() => setAdding(true)}>Add a document</button>
      : <form onSubmit={submit} className="portal-form">
          <label><span className="field-caption">Title</span>
            <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Medical form" disabled={busy} />
          </label>
          <label><span className="field-caption">Kind</span>
            <input value={kind} onChange={(event) => setKind(event.target.value)} placeholder="form / letter / record" disabled={busy} />
          </label>
          <label className="file-drop"><span className="field-caption">File</span>
            <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
          </label>
          <div className="row-actions">
            <button disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { setAdding(false); setTitle(""); setFile(null); }}>Cancel</button>
          </div>
          <p className="admin-form-status" role="status">{status}</p>
        </form>}
  </div>;
}
