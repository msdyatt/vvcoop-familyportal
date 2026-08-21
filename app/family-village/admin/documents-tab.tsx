"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../../lib/storage";

type DocRow = {
  id: string; title: string; kind: string; signature_status: string | null; storage_path: string | null;
  family_id: string | null; class_id: string | null; families: { display_name: string } | null; classes: { title: string } | null;
};
type FamilyOption = { id: string; display_name: string };

export default function DocumentsTab({ actorUserId }: { actorUserId: string }) {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [families, setFamilies] = useState<FamilyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data }, { data: familyRows }] = await Promise.all([
      supabase.from("documents").select("id,title,kind,signature_status,storage_path,family_id,class_id,families(display_name),classes(title)").order("created_at", { ascending: false }).limit(60),
      supabase.from("families").select("id,display_name").order("display_name"),
    ]);
    setDocs((data ?? []) as unknown as DocRow[]);
    setFamilies((familyRows ?? []) as FamilyOption[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function save(row: DocRow) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("documents").update({ title: row.title, kind: row.kind, signature_status: row.signature_status }).eq("id", row.id);
    if (error) { setStatus(error.message); return; }
    setStatus(`Saved ${row.title}.`);
    await load();
  }

  async function remove(id: string, title: string) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("documents").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    await load();
  }

  async function download(path: string | null) {
    if (!path) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path);
    if (url) window.open(url, "_blank");
  }

  if (loading) return <p>Loading documents…</p>;

  return <section className="documents-manage">
    <UploadForm families={families} actorUserId={actorUserId} onUploaded={load} />
    <p className="admin-form-status" role="status">{status}</p>
    <div className="documents-list">
      {docs.map((row) => <DocRowCard key={row.id} row={row} onSave={save} onDelete={remove} onDownload={download} />)}
      {!docs.length && <p className="portal-empty">No documents yet.</p>}
    </div>
  </section>;
}

function DocRowCard({ row, onSave, onDelete, onDownload }: { row: DocRow; onSave: (row: DocRow) => void; onDelete: (id: string, title: string) => void; onDownload: (path: string | null) => void }) {
  const [local, setLocal] = useState(row);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync when parent data reloads
  useEffect(() => { setLocal(row); }, [row]);

  return <article className="document-card">
    <div className="field-row">
      <label>Title<input value={local.title} onChange={(event) => setLocal({ ...local, title: event.target.value })} /></label>
      <label>Kind<input value={local.kind} onChange={(event) => setLocal({ ...local, kind: event.target.value })} /></label>
      <label>Signature status<input value={local.signature_status ?? ""} onChange={(event) => setLocal({ ...local, signature_status: event.target.value })} placeholder="pending / signed / not required" /></label>
    </div>
    <div className="document-card-meta">
      <span>{row.families?.display_name ? `Family: ${row.families.display_name}` : row.classes?.title ? `Class: ${row.classes.title}` : "Unattached"}</span>
      <div className="row-actions">
        {row.storage_path && <button onClick={() => onDownload(row.storage_path)}>Open</button>}
        <button onClick={() => onSave(local)}>Save</button>
        <button className="danger" onClick={() => onDelete(row.id, row.title)}>Delete</button>
      </div>
    </div>
  </article>;
}

function UploadForm({ families, actorUserId, onUploaded }: { families: FamilyOption[]; actorUserId: string; onUploaded: () => void }) {
  const [familyId, setFamilyId] = useState("");
  const [title, setTitle] = useState(""); const [kind, setKind] = useState("form");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim() || !familyId) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "documents", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("documents").insert({ family_id: familyId, kind, title: title.trim(), storage_path: uploaded.path, uploaded_by_user_id: actorUserId });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setFamilyId(""); setStatus("Uploaded.");
    onUploaded();
  }

  return <form onSubmit={submit} className="add-class-form">
    <label>Family<select required value={familyId} onChange={(event) => setFamilyId(event.target.value)}><option value="">Choose a family…</option>{families.map((row) => <option key={row.id} value={row.id}>{row.display_name}</option>)}</select></label>
    <label>Title<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Liability waiver" disabled={busy} /></label>
    <label>Kind<input required value={kind} onChange={(event) => setKind(event.target.value)} placeholder="form / waiver / handbook" disabled={busy} /></label>
    <label className="file-drop">File<input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
    <button disabled={busy}>{busy ? "Uploading…" : "Upload document"}</button>
    <p className="admin-form-status" role="status">{status}</p>
  </form>;
}
