"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET } from "../../../lib/storage";
import { resizeImage } from "../../../lib/image-resize";
import type { Album, ClassOption, YearOption } from "../../../lib/photos";
import DetailModal from "../detail-modal";

type FileState = { name: string; state: "waiting" | "working" | "done" | "failed"; note?: string };

/**
 * Adding photos. Teachers and administrators publish straight away; anyone else
 * submits for approval. Each photo is shrunk, stripped of location data, and
 * uploaded as a full-size file and a thumbnail before it is registered.
 */
export default function PhotoUpload({ roles, userId, classes, albums, teachingIds, years, onClose, onDone }: {
  roles: string[]; userId: string; classes: ClassOption[]; albums: Album[]; teachingIds: Set<string>;
  years: YearOption[]; onClose: () => void; onDone: () => void;
}) {
  const isAdmin = roles.includes("admin");
  const isStaff = isAdmin || roles.includes("teacher");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<FileState[]>([]);
  const [visibility, setVisibility] = useState<"coop" | "class">("coop");
  const [classId, setClassId] = useState("");
  const [albumId, setAlbumId] = useState("");
  const [newAlbum, setNewAlbum] = useState("");
  const [takenOn, setTakenOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [caption, setCaption] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState("");
  const [childClasses, setChildClasses] = useState<ClassOption[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // The classes a person may file photos under: any (administrator), the ones
  // they teach, and the ones their children are in.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void supabase.from("enrollments").select("class_id,classes(id,title)").eq("status", "active").then(({ data }) => {
      setChildClasses((data ?? []).map((row) => (row as unknown as { classes: ClassOption | null }).classes).filter((row): row is ClassOption => !!row));
    });
  }, []);

  const myClasses = useMemo(() => {
    if (isAdmin) return classes;
    const known = new Map<string, ClassOption>();
    if (roles.includes("teacher")) for (const row of classes) if (teachingIds.has(row.id)) known.set(row.id, row);
    for (const row of childClasses) known.set(row.id, row);
    return [...known.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [isAdmin, roles, classes, teachingIds, childClasses]);

  const albumChoices = albums.filter((album) => !album.class_id || myClasses.some((row) => row.id === album.class_id) || isAdmin);
  const needsClass = visibility === "class";
  const ready = files.length > 0 && confirmed && (!needsClass || classId) && !busy;

  function setState(index: number, patch: Partial<FileState>) {
    setProgress((previous) => previous.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function upload() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !ready) return;
    setBusy(true); setMessage("");
    setProgress(files.map((file) => ({ name: file.name, state: "waiting" })));

    let album: string | null = albumId || null;
    if (isStaff && newAlbum.trim()) {
      const { data, error } = await supabase.rpc("create_album", { p_title: newAlbum.trim(), p_class_id: classId || null, p_school_year_id: null, p_event_on: takenOn || null });
      if (error) { setMessage(error.message); setBusy(false); return; }
      album = String(data);
    }

    let published = 0; let pending = 0; let failed = 0;
    for (let index = 0; index < files.length; index += 1) {
      setState(index, { state: "working" });
      const id = crypto.randomUUID();
      const fullPath = `library/${id}/full.jpg`;
      const thumbPath = `library/${id}/thumb.jpg`;
      try {
        const [full, thumb] = [await resizeImage(files[index], 2000, 0.85), await resizeImage(files[index], 480, 0.8)];
        for (const [path, blob] of [[fullPath, full], [thumbPath, thumb]] as const) {
          const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
          if (error) throw new Error(error.message);
        }
        const { data, error } = await supabase.rpc("add_photo", {
          p_id: id, p_visibility: visibility, p_class_id: classId || null, p_album_id: album,
          p_caption: caption.trim() || null, p_taken_on: takenOn || null, p_confirmed: confirmed,
        });
        if (error) throw new Error(error.message);
        if (data === "published") published += 1; else pending += 1;
        setState(index, { state: "done" });
      } catch (error) {
        failed += 1;
        void supabase.storage.from(PRIVATE_BUCKET).remove([fullPath, thumbPath]);
        setState(index, { state: "failed", note: error instanceof Error ? error.message : "Could not upload" });
      }
    }

    setBusy(false); setDone(true);
    setMessage([
      published ? `${published} photo${published === 1 ? "" : "s"} added to the library.` : "",
      pending ? `${pending} submitted. A teacher or administrator will review ${pending === 1 ? "it" : "them"} before ${pending === 1 ? "it appears" : "they appear"}.` : "",
      failed ? `${failed} could not be added.` : "",
    ].filter(Boolean).join(" "));
    if (published || pending) onDone();
  }

  return <DetailModal title={isStaff ? "Add photos" : "Submit photos"} onClose={onClose}>
    <div className="portal-form photos-upload">
      {!isStaff && <p className="portal-empty">A teacher or administrator reviews each photo before it appears in the library.</p>}

      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { setFiles([...(event.target.files ?? [])].slice(0, 30)); setProgress([]); setDone(false); }} />
      <button type="button" className="ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
        {files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} chosen (up to 30)` : "Choose photos"}
      </button>

      <fieldset className="photos-visibility" disabled={busy}>
        <legend className="field-caption">Who can see {files.length > 1 ? "them" : "it"}</legend>
        <label><input type="radio" name="visibility" checked={visibility === "coop"} onChange={() => setVisibility("coop")} /> The whole co-op</label>
        <label><input type="radio" name="visibility" checked={visibility === "class"} onChange={() => setVisibility("class")} /> One class only</label>
      </fieldset>

      <label><span className="field-caption">Class {needsClass ? "" : "(optional, so it can be filtered)"}</span>
        <select value={classId} onChange={(event) => { setClassId(event.target.value); setAlbumId(""); }} disabled={busy}>
          <option value="">{needsClass ? "Choose a class" : "No class"}</option>
          {myClasses.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select>
      </label>

      <label><span className="field-caption">Album (optional)</span>
        <select value={albumId} onChange={(event) => setAlbumId(event.target.value)} disabled={busy || !!newAlbum.trim()}>
          <option value="">No album</option>
          {albumChoices.filter((album) => !classId || album.class_id === classId || !album.class_id).map((album) => <option key={album.id} value={album.id}>{album.title}</option>)}
        </select>
      </label>
      {isStaff && <label><span className="field-caption">…or start a new album</span>
        <input value={newAlbum} maxLength={100} onChange={(event) => setNewAlbum(event.target.value)} placeholder="Spring recital" disabled={busy} />
      </label>}

      <label><span className="field-caption">Date taken</span>
        <input type="date" value={takenOn} onChange={(event) => setTakenOn(event.target.value)} disabled={busy} />
      </label>
      <label><span className="field-caption">Caption (optional)</span>
        <input value={caption} maxLength={300} onChange={(event) => setCaption(event.target.value)} placeholder="What was happening" disabled={busy} />
      </label>
      {years.length > 0 && <p className="portal-empty">The school year is filled in from the class or album, or the current year.</p>}

      <label className="photos-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />
        <span>I have permission to share {files.length > 1 ? "these photos" : "this photo"} with the people chosen above.</span>
      </label>

      {progress.length > 0 && <ul className="photos-progress">
        {progress.map((item, index) => <li key={`${item.name}-${index}`} className={item.state}>
          <span>{item.name}</span><i>{item.state === "working" ? "Uploading…" : item.state === "done" ? "Added" : item.state === "failed" ? item.note : "Waiting"}</i>
        </li>)}
      </ul>}

      {message && <p className="admin-form-status" role="status">{message}</p>}
      <div className="row-actions">
        {!done && <button type="button" disabled={!ready} onClick={upload}>{busy ? "Uploading…" : isStaff ? "Add to library" : "Submit for review"}</button>}
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
      </div>
      <span hidden>{userId}</span>
    </div>
  </DetailModal>;
}
