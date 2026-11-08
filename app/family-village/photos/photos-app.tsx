"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import LoadingScreen from "../loading-screen";
import { PRIVATE_BUCKET, getSignedFileUrls } from "../../../lib/storage";
import { usePortalAccess } from "../../../lib/use-portal-access";
import { PHOTO_COLUMNS, PHOTO_PAGE, likePattern, photoDate, type Album, type ClassOption, type PhotoRow, type YearOption } from "../../../lib/photos";
import AppHeader from "../app-header";
import MfaChallengeScreen from "../mfa-challenge";
import PhotoUpload from "./photo-upload";
import PhotoViewer from "./photo-viewer";

type Filters = { year: string; classId: string; album: string; search: string; mine: boolean };
const NO_FILTERS: Filters = { year: "", classId: "", album: "", search: "", mine: false };

export default function PhotosApp() {
  const { state: access, userId, roles, recheck } = usePortalAccess("member");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [pending, setPending] = useState<PhotoRow[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [years, setYears] = useState<YearOption[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [teachingIds, setTeachingIds] = useState<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const isStaff = roles.includes("admin") || roles.includes("teacher");

  const loadThumbs = useCallback(async (rows: PhotoRow[]) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !rows.length) return;
    const urls = await getSignedFileUrls(supabase, rows.map((row) => row.thumb_path));
    setThumbs((previous) => new Map([...previous, ...urls]));
  }, []);

  const query = useCallback((from: number) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return null;
    let q = supabase.from("photos").select(PHOTO_COLUMNS).eq("status", "published");
    if (filters.year) q = q.eq("school_year_id", filters.year);
    if (filters.classId) q = q.eq("class_id", filters.classId);
    if (filters.album) q = q.eq("album_id", filters.album);
    if (filters.mine) q = q.eq("uploaded_by", userId);
    if (filters.search.trim()) q = q.ilike("caption", likePattern(filters.search.trim()));
    return q.order("taken_on", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).range(from, from + PHOTO_PAGE - 1);
  }, [filters, userId]);

  const loadPhotos = useCallback(async () => {
    const q = query(0);
    if (!q) return;
    const { data, error } = await q;
    if (error) { setStatus(error.message); setLoaded(true); return; }
    const rows = (data ?? []) as PhotoRow[];
    setPhotos(rows);
    setHasMore(rows.length === PHOTO_PAGE);
    setLoaded(true);
    void loadThumbs(rows);
  }, [query, loadThumbs]);

  async function loadMore() {
    const q = query(photos.length);
    if (!q) return;
    const { data } = await q;
    const rows = (data ?? []) as PhotoRow[];
    setPhotos((previous) => [...previous, ...rows]);
    setHasMore(rows.length === PHOTO_PAGE);
    void loadThumbs(rows);
  }

  const loadPending = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("photos").select(PHOTO_COLUMNS).eq("status", "pending").order("created_at", { ascending: true });
    const rows = (data ?? []) as PhotoRow[];
    setPending(rows);
    void loadThumbs(rows);
  }, [loadThumbs]);

  // The choices in the filter bar, and which classes this person teaches.
  useEffect(() => {
    if (access !== "ready") return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    (async () => {
      const [{ data: yearRows }, { data: classRows }, { data: albumRows }, { data: teachRows }] = await Promise.all([
        supabase.from("school_years").select("id,label,is_current").order("starts_on", { ascending: false }),
        supabase.from("classes").select("id,title").eq("active", true).order("title"),
        supabase.from("photo_albums").select("id,title,class_id,school_year_id,event_on").order("created_at", { ascending: false }),
        supabase.from("teacher_assignments").select("class_id").eq("user_id", userId),
      ]);
      setYears((yearRows ?? []) as YearOption[]);
      setClasses((classRows ?? []) as ClassOption[]);
      setAlbums((albumRows ?? []) as Album[]);
      setTeachingIds(new Set((teachRows ?? []).map((row) => row.class_id as string)));
    })();
  }, [access, userId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when the filters change
  useEffect(() => { if (access === "ready") void loadPhotos(); }, [access, loadPhotos]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch once ready
  useEffect(() => { if (access === "ready") void loadPending(); }, [access, loadPending]);

  async function reviewPhoto(photo: PhotoRow, approve: boolean) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setStatus("");
    if (approve) {
      const { error } = await supabase.rpc("approve_photo", { p_id: photo.id });
      if (error) { setStatus(error.message); return; }
    } else {
      const { data, error } = await supabase.rpc("delete_photo", { p_id: photo.id });
      if (error) { setStatus(error.message); return; }
      if (Array.isArray(data) && data.length) await supabase.storage.from(PRIVATE_BUCKET).remove(data as string[]);
    }
    await Promise.all([loadPending(), loadPhotos()]);
  }

  async function afterChange() {
    const supabase = getSupabaseBrowserClient();
    await Promise.all([loadPhotos(), loadPending()]);
    if (supabase) {
      const { data } = await supabase.from("photo_albums").select("id,title,class_id,school_year_id,event_on").order("created_at", { ascending: false });
      setAlbums((data ?? []) as Album[]);
    }
  }

  async function signOutToEntry() {
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  if (access === "loading") return <LoadingScreen />;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><a href="/family-village">Return to sign in →</a></main>;

  const canReview = (photo: PhotoRow) => roles.includes("admin") || (photo.class_id !== null && teachingIds.has(photo.class_id));
  const open = [...photos, ...pending].find((row) => row.id === openId) ?? null;
  const anyFilter = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const visibleAlbums = albums.filter((album) => (!filters.classId || album.class_id === filters.classId) && (!filters.year || album.school_year_id === filters.year));

  const tile = (photo: PhotoRow, extra?: React.ReactNode) => <li key={photo.id} className="photos-tile">
    <button type="button" className="photos-thumb" onClick={() => setOpenId(photo.id)} aria-label={photo.caption ? `Open photo: ${photo.caption}` : "Open photo"}>
      {thumbs.get(photo.thumb_path)
        // eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage; next/image can't optimize it
        ? <img src={thumbs.get(photo.thumb_path)} alt={photo.caption ?? "Library item"} loading="lazy" />
        : <span className="photos-thumb-loading" />}
    </button>
    {photo.caption && <span className="photos-caption">{photo.caption}</span>}
    {extra}
  </li>;

  return <main className="workspace-preview photos-page">
    <AppHeader current="home" roles={roles} title="Photos" subtitle="The co-op's shared library, kept here." />

    <div className="photos-toolbar">
      <div className="photos-filters">
        <label><span className="field-caption">School year</span>
          <select value={filters.year} onChange={(event) => setFilters({ ...filters, year: event.target.value, album: "" })}>
            <option value="">All years</option>
            {years.map((year) => <option key={year.id} value={year.id}>{year.label}{year.is_current ? " (current)" : ""}</option>)}
          </select>
        </label>
        <label><span className="field-caption">Class</span>
          <select value={filters.classId} onChange={(event) => setFilters({ ...filters, classId: event.target.value, album: "" })}>
            <option value="">All classes</option>
            {classes.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
          </select>
        </label>
        <label><span className="field-caption">Album</span>
          <select value={filters.album} onChange={(event) => setFilters({ ...filters, album: event.target.value })}>
            <option value="">All albums</option>
            {visibleAlbums.map((album) => <option key={album.id} value={album.id}>{album.title}</option>)}
          </select>
        </label>
        <label><span className="field-caption">Search captions</span>
          <input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="field trip" />
        </label>
        <label className="photos-mine"><input type="checkbox" checked={filters.mine} onChange={(event) => setFilters({ ...filters, mine: event.target.checked })} /> Added by me</label>
        {anyFilter && <button type="button" className="ghost" onClick={() => setFilters(NO_FILTERS)}>Clear</button>}
      </div>
      <button type="button" onClick={() => setUploading(true)}>{isStaff ? "Add photos" : "Submit photos"}</button>
    </div>

    {status && <p className="admin-form-status" role="status">{status}</p>}

    {pending.length > 0 && <section className="photos-pending">
      <p className="eyebrow">{pending.some(canReview) ? "Waiting for approval" : "Your submissions"}</p>
      <ul className="photos-grid">
        {pending.map((photo) => tile(photo, canReview(photo)
          ? <span className="photos-review">
              <button type="button" onClick={() => reviewPhoto(photo, true)}>Approve</button>
              <button type="button" className="ghost" onClick={() => reviewPhoto(photo, false)}>Reject</button>
            </span>
          : <span className="photos-caption">Waiting for review</span>))}
      </ul>
    </section>}

    {!loaded && <p className="portal-empty">Loading…</p>}
    {loaded && !photos.length && <p className="portal-empty">{anyFilter ? "No photos match these filters." : "No photos have been added yet."}</p>}
    <ul className="photos-grid">{photos.map((photo) => tile(photo))}</ul>
    {hasMore && <p className="photos-more"><button type="button" className="ghost" onClick={loadMore}>Show more</button></p>}

    {uploading && <PhotoUpload roles={roles} userId={userId} classes={classes} albums={albums} teachingIds={teachingIds} years={years}
      onClose={() => setUploading(false)} onDone={() => { void afterChange(); }} />}
    {open && <PhotoViewer photo={open} userId={userId} isAdmin={roles.includes("admin")} teachingIds={teachingIds}
      albums={albums} classes={classes} onClose={() => setOpenId(null)} onChanged={afterChange} />}
    <p className="portal-empty photos-note">Photos here are for the co-op&rsquo;s families only. {photos[0] ? `Most recent: ${photoDate(photos[0])}.` : ""}</p>
  </main>;
}
