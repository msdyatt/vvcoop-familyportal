"use client";

import { FormEvent, useEffect, useState } from "react";
import { edgeFunctionUrl, getSupabaseBrowserClient } from "../../../lib/supabase";
import { uploadPrivateFile } from "../../../lib/storage";
import { sanitizeRichText, stripRichText } from "../../../lib/rich-text";
import { PostThumbnail, usePostAttachments } from "../post-attachments";
import RichTextEditor from "../rich-text-editor";

type Post = { id: string; title: string; body: string; audience: string; class_id: string | null; published_at: string | null };
type ClassOption = { id: string; title: string };
type CalendarEvent = { id: string; title: string; description: string | null; starts_at: string; ends_at: string | null; location: string | null; audience: string; all_day: boolean };

export default function NewsTab({ actorUserId }: { actorUserId: string }) {
  const [view, setView] = useState<"news" | "calendar">("news");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [audience, setAudience] = useState("families");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");
  const attachments = usePostAttachments(posts.map((post) => post.id));

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data, error }, { data: classRows }, { data: eventRows }] = await Promise.all([
      supabase.from("posts").select("id,title,body,audience,class_id,published_at").order("created_at", { ascending: false }).limit(40),
      supabase.from("classes").select("id,title").order("title"),
      supabase.from("events").select("id,title,description,starts_at,ends_at,location,audience,all_day").is("class_id", null).order("starts_at", { ascending: false }).limit(60),
    ]);
    if (error) return;
    setPosts((data ?? []) as Post[]);
    setClasses((classRows ?? []) as ClassOption[]);
    setEvents((eventRows ?? []) as CalendarEvent[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function removePost(id: string, headline: string) {
    if (!confirm(`Delete "${headline}"? Families and teachers will no longer see it, and its photos go with it. This cannot be undone.`)) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const { error } = await supabase.from("posts").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    setStatus(`Deleted "${headline}".`); await load();
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    const cleanBody = sanitizeRichText(body);
    if (!supabase || !title.trim() || !stripRichText(cleanBody)) return;
    if (audience === "class" && !classId) { setStatus("Choose which class this is for."); return; }
    setBusy(true); setStatus("");

    const uploaded: { path: string; file: File }[] = [];
    for (const file of files) {
      const result = await uploadPrivateFile(supabase, "news", file);
      if ("error" in result) { setStatus(`${file.name}: ${result.error}`); setBusy(false); return; }
      uploaded.push({ path: result.path, file });
    }

    const payload = { title: title.trim(), body: cleanBody, audience, class_id: audience === "class" ? classId || null : null };
    const write = editingId
      ? supabase.from("posts").update(payload).eq("id", editingId).select("id").single()
      : supabase.from("posts").insert({ ...payload, author_user_id: actorUserId, published_at: new Date().toISOString() }).select("id").single();
    const { data: post, error } = await write;
    if (error) { setStatus(error.message); setBusy(false); return; }

    if (uploaded.length) {
      const existingCount = attachments[post.id]?.length ?? 0;
      const { error: attachError } = await supabase.from("post_attachments").insert(uploaded.map((item, index) => ({ post_id: post.id, storage_path: item.path, file_name: item.file.name, content_type: item.file.type || null, sort_order: existingCount + index })));
      if (attachError) { setStatus(`Saved, but the new files could not be attached: ${attachError.message}`); setBusy(false); await load(); return; }
    }

    const wasEditing = !!editingId;
    setBusy(false); setTitle(""); setBody(""); setFiles([]); setAudience("families"); setClassId(""); setEditingId(null);
    setStatus(wasEditing ? "News item updated." : uploaded.length ? `Published with ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}.` : "Published."); await load();
  }

  function editPost(post: Post) {
    setEditingId(post.id); setTitle(post.title); setBody(post.body); setAudience(post.audience); setClassId(post.class_id ?? ""); setFiles([]); setStatus(`Editing “${post.title}”.`);
  }

  function cancelEdit() {
    setEditingId(null); setTitle(""); setBody(""); setAudience("families"); setClassId(""); setFiles([]); setStatus("");
  }

  return <section className="publishing-tab">
    <div className="publishing-switch" role="tablist" aria-label="Publishing tools">
      <button role="tab" aria-selected={view === "news"} className={view === "news" ? "active" : ""} onClick={() => setView("news")}>News &amp; media</button>
      <button role="tab" aria-selected={view === "calendar"} className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>Village calendar</button>
    </div>
    {view === "news" ? <>
      <form className="news-composer" onSubmit={publish}>
        <input required placeholder="Headline" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        <RichTextEditor key={editingId ?? "new"} value={body} onChange={setBody} disabled={busy} />
        <div className="composer-row">
          <select value={audience} onChange={(event) => setAudience(event.target.value)} disabled={busy}><option value="families">Every family</option><option value="teachers">Teaching team only</option><option value="class">One class</option><option value="public">Front page</option></select>
          {audience === "class" && <select value={classId} onChange={(event) => setClassId(event.target.value)} disabled={busy}><option value="">Choose a class…</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select>}
          <label className="file-drop"><span className="field-caption">Photos or files <i>optional</i></span><input type="file" multiple onChange={(event) => setFiles([...(event.target.files ?? [])])} disabled={busy} /></label>
        </div>
        <p className="composer-hint">{audience === "public" ? "Shown in the public news section on the main site." : audience === "teachers" ? "Shown in the Teacher's Lounge only." : audience === "class" ? "Shown to that class's teaching team and enrolled families." : "Shown on every family's dashboard."}</p>
        {files.length > 0 && <p className="composer-files">{files.length} file{files.length === 1 ? "" : "s"} ready: {files.map((file) => file.name).join(", ")}</p>}
        <div className="row-actions"><button disabled={busy}>{busy ? "Saving…" : editingId ? "Save changes" : "Publish news"}</button>{editingId && <button type="button" className="ghost" onClick={cancelEdit} disabled={busy}>Cancel edit</button>}</div><p className="admin-form-status" role="status">{status}</p>
      </form>
      <div className="news-list">{posts.map((post) => <article className="news-item" key={post.id}><PostThumbnail attachments={attachments[post.id] ?? []} /><div><b>{post.title}</b><span>{post.audience} · {post.published_at ? new Date(post.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Draft"}{(attachments[post.id]?.length ?? 0) > 0 ? ` · ${attachments[post.id].length} file${attachments[post.id].length === 1 ? "" : "s"}` : ""}</span><small>{stripRichText(post.body).slice(0, 150)}</small></div><div className="row-actions"><button onClick={() => editPost(post)}>Edit</button><button className="danger" onClick={() => removePost(post.id, post.title)}>Delete</button></div></article>)}{!posts.length && <p>No news published yet.</p>}</div>
    </> : <CalendarPublisher events={events} onSaved={load} onStatus={setStatus} status={status} />}
  </section>;
}

function CalendarPublisher({ events, onSaved, onStatus, status }: { events: CalendarEvent[]; onSaved: () => void; onStatus: (message: string) => void; status: string }) {
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [location, setLocation] = useState("");
  // Most co-op events are a date on the calendar, not a specific meeting time -- all-day is the default, with a toggle for the few that need one.
  const [allDay, setAllDay] = useState(true);
  const [startsAt, setStartsAt] = useState(""); const [endsAt, setEndsAt] = useState(""); const [audience, setAudience] = useState("families"); const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function inputDateTime(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function inputDate(value: string | null) {
    return value ? value.slice(0, 10) : "";
  }

  async function createEvent(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !startsAt) return;
    if (endsAt && endsAt < startsAt) { onStatus("An event cannot end before it starts."); return; }
    setBusy(true);
    const payload = {
      title: title.trim(), description: description.trim() || null, location: location.trim() || null,
      starts_at: allDay ? `${startsAt}T00:00:00.000Z` : new Date(startsAt).toISOString(),
      ends_at: endsAt ? (allDay ? `${endsAt}T00:00:00.000Z` : new Date(endsAt).toISOString()) : null,
      all_day: allDay, audience, class_id: null,
    };
    const { error } = editingId
      ? await supabase.from("events").update(payload).eq("id", editingId)
      : await supabase.from("events").insert(payload);
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    onStatus(editingId ? `Updated ${title.trim()}.` : `Added ${title.trim()} to the Village calendar.`); setTitle(""); setDescription(""); setLocation(""); setStartsAt(""); setEndsAt(""); setAllDay(true); setAudience("families"); setEditingId(null); onSaved();
  }

  function editEvent(row: CalendarEvent) {
    setEditingId(row.id); setTitle(row.title); setDescription(row.description ?? ""); setLocation(row.location ?? "");
    setAllDay(row.all_day);
    setStartsAt(row.all_day ? inputDate(row.starts_at) : inputDateTime(row.starts_at));
    setEndsAt(row.all_day ? inputDate(row.ends_at) : inputDateTime(row.ends_at));
    setAudience(row.audience); onStatus(`Editing “${row.title}”.`);
  }

  function cancelEdit() {
    setEditingId(null); setTitle(""); setDescription(""); setLocation(""); setStartsAt(""); setEndsAt(""); setAllDay(true); setAudience("families"); onStatus("");
  }

  async function removeEvent(row: CalendarEvent) {
    if (!confirm(`Delete "${row.title}" from the calendar?`)) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const { error } = await supabase.from("events").delete().eq("id", row.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`Deleted ${row.title}.`); onSaved();
  }

  // Switching form kinds rather than converting between them -- a datetime-local
  // and a date value aren't safely convertible without picking a timezone to
  // guess with, so this just asks for the date/time again instead of guessing.
  function toggleAllDay(next: boolean) {
    setAllDay(next);
    setStartsAt("");
    setEndsAt("");
  }

  return <><p className="composer-hint">Anyone can subscribe to the co-op-wide calendar in their own calendar app: <a href={`${edgeFunctionUrl("calendar-feed")}?scope=public`} target="_blank" rel="noreferrer">Subscribe to this calendar ↗</a></p>
  <form className="news-composer event-composer" onSubmit={createEvent}>
    <input required placeholder="Event title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
    <textarea placeholder="Details families should know" value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
    <label className="checkbox-field"><input type="checkbox" checked={allDay} onChange={(event) => toggleAllDay(event.target.checked)} disabled={busy} /> All day (no specific meeting time)</label>
    <div className="composer-row">
      <label><span className="field-caption">Starts</span>
        {allDay
          ? <input required type="date" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} disabled={busy} />
          : <input required type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} disabled={busy} />}
      </label>
      <label><span className="field-caption">Ends <i>optional</i></span>
        {allDay
          ? <input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={busy} />
          : <input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={busy} />}
      </label>
      <label><span className="field-caption">Location</span><input value={location} onChange={(event) => setLocation(event.target.value)} disabled={busy} /></label>
      <label><span className="field-caption">Audience</span><select value={audience} onChange={(event) => setAudience(event.target.value)} disabled={busy}><option value="families">Every family</option><option value="teachers">Teaching team</option><option value="public">Public audience</option></select></label>
    </div>
    <div className="row-actions"><button disabled={busy}>{busy ? "Saving…" : editingId ? "Save event" : "Add calendar event"}</button>{editingId && <button type="button" className="ghost" onClick={cancelEdit} disabled={busy}>Cancel edit</button>}</div><p className="admin-form-status" role="status">{status}</p>
  </form><div className="news-list calendar-admin-list">{events.map((row) => <article className="news-item" key={row.id}><time>{new Date(row.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: row.all_day ? "UTC" : undefined })}</time><div><b>{row.title}</b><span>{row.all_day ? "All day" : new Date(row.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}{row.location ? ` · ${row.location}` : ""} · {row.audience}</span></div><div className="row-actions"><button onClick={() => editEvent(row)}>Edit</button><button className="danger" onClick={() => removeEvent(row)}>Delete</button></div></article>)}{!events.length && <p className="portal-empty">No co-op-wide events have been added yet.</p>}</div></>;
}
