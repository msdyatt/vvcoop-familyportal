"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET } from "../../../lib/storage";
import { photoDate, type Album, type ClassOption, type PhotoRow } from "../../../lib/photos";
import DetailModal from "../detail-modal";

export default function PhotoViewer({ photo, userId, isAdmin, teachingIds, albums, classes, onClose, onChanged }: {
  photo: PhotoRow; userId: string; isAdmin: boolean; teachingIds: Set<string>;
  albums: Album[]; classes: ClassOption[]; onClose: () => void; onChanged: () => void | Promise<void>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(photo.caption ?? "");
  const [albumId, setAlbumId] = useState(photo.album_id ?? "");
  const [takenOn, setTakenOn] = useState(photo.taken_on ?? "");
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("");

  const canManage = isAdmin || photo.uploaded_by === userId || (photo.class_id !== null && teachingIds.has(photo.class_id));
  const className = classes.find((row) => row.id === photo.class_id)?.title;
  const albumTitle = albums.find((row) => row.id === photo.album_id)?.title;

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(photo.storage_path, 3600).then(({ data }) => setUrl(data?.signedUrl ?? null));
  }, [photo.storage_path]);

  async function download() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(photo.storage_path, 300, { download: "veritas-village-photo.jpg" });
    if (data?.signedUrl) window.location.assign(data.signedUrl);
  }

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("update_photo", { p_id: photo.id, p_caption: caption, p_album_id: albumId || null, p_taken_on: takenOn || null });
    if (error) { setStatus(error.message); return; }
    setEditing(false); setStatus("Saved.");
    await onChanged();
  }

  async function remove() {
    if (!confirm("Remove this photo from the library for everyone?")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("delete_photo", { p_id: photo.id });
    if (error) { setStatus(error.message); return; }
    if (Array.isArray(data) && data.length) await supabase.storage.from(PRIVATE_BUCKET).remove(data as string[]);
    await onChanged();
    onClose();
  }

  async function report() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("report_photo", { p_id: photo.id, p_reason: reason });
    if (error) { setStatus(error.message); return; }
    setReporting(false); setReason("");
    setStatus("Thank you. An administrator will look at this photo.");
  }

  return <DetailModal title={photo.caption ?? "Photo"} onClose={onClose}>
    <div className="photos-viewer">
      {url
        // eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage
        ? <img src={url} alt={photo.caption ?? "Library item"} />
        : <p className="portal-empty">Loading…</p>}
      <dl className="photos-facts">
        <div><dt>Date</dt><dd>{photoDate(photo)}</dd></div>
        {className && <div><dt>Class</dt><dd>{className}</dd></div>}
        {albumTitle && <div><dt>Album</dt><dd>{albumTitle}</dd></div>}
        <div><dt>Shared with</dt><dd>{photo.visibility === "coop" ? "The whole co-op" : `Families and teachers of ${className ?? "the class"}`}</dd></div>
        {photo.status === "pending" && <div><dt>Status</dt><dd>Waiting for review</dd></div>}
      </dl>

      {editing && <div className="portal-form">
        <label><span className="field-caption">Caption</span><input value={caption} maxLength={300} onChange={(event) => setCaption(event.target.value)} /></label>
        <label><span className="field-caption">Album</span>
          <select value={albumId} onChange={(event) => setAlbumId(event.target.value)}>
            <option value="">No album</option>
            {albums.map((album) => <option key={album.id} value={album.id}>{album.title}</option>)}
          </select>
        </label>
        <label><span className="field-caption">Date taken</span><input type="date" value={takenOn} onChange={(event) => setTakenOn(event.target.value)} /></label>
        <div className="row-actions"><button type="button" onClick={save}>Save</button><button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button></div>
      </div>}

      {reporting && <div className="portal-form">
        <p className="portal-empty">Tell an administrator what is wrong, for example a child whose family asked not to be photographed.</p>
        <label><span className="field-caption">What is wrong?</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} /></label>
        <div className="row-actions"><button type="button" disabled={!reason.trim()} onClick={report}>Send report</button><button type="button" className="ghost" onClick={() => setReporting(false)}>Cancel</button></div>
      </div>}

      {status && <p className="admin-form-status" role="status">{status}</p>}
      <div className="row-actions">
        <button type="button" onClick={download} disabled={!url}>Download</button>
        {canManage && !editing && <button type="button" className="ghost" onClick={() => setEditing(true)}>Edit details</button>}
        {!reporting && <button type="button" className="ghost" onClick={() => setReporting(true)}>Report</button>}
        {canManage && <button type="button" className="danger" onClick={remove}>Remove</button>}
      </div>
    </div>
  </DetailModal>;
}
