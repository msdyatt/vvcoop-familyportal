"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import SubscribeLink from "../subscribe-link";
import { uploadPrivateFile } from "../../../lib/storage";
import { inlineImagePaths, sanitizeRichText, stripRichText } from "../../../lib/rich-text";
import { PostThumbnail, usePostAttachments } from "../post-attachments";
import RichTextEditor from "../rich-text-editor";
import { addCalendarDays, coopWallTime, coopWallTimeToDate, formatCoopDateTime } from "../../../lib/coop-time";
import { reminderLine, type ReminderRow } from "./event-reminders";

type Post = {
  id: string; title: string; body: string; audience: string; class_id: string | null; published_at: string | null;
  scheduled_for: string | null; schedule_held_reason: string | null;
};
type ClassOption = { id: string; title: string };
type CalendarEvent = { id: string; title: string; description: string | null; starts_at: string; ends_at: string | null; location: string | null; audience: string; all_day: boolean };

const POST_COLUMNS = "id,title,body,audience,class_id,published_at,scheduled_for,schedule_held_reason";

/** Tomorrow at 8:00 AM Central: where the "Publish later" boxes start. */
function defaultSchedule() {
  return { date: addCalendarDays(coopWallTime(new Date()).date, 1), time: "08:00" };
}

export default function NewsTab({ actorUserId }: { actorUserId: string }) {
  const [view, setView] = useState<"news" | "calendar">("news");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [waiting, setWaiting] = useState<Post[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [audience, setAudience] = useState("families");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [whenDate, setWhenDate] = useState(() => defaultSchedule().date); const [whenTime, setWhenTime] = useState("08:00");
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");
  const attachments = usePostAttachments([...waiting, ...posts].map((post) => post.id));

  // A post that has not gone out yet (scheduled, or kept as a draft) can only be saved as "publish later": a
  // post that has gone out has no schedule left to edit.
  const editing = [...waiting, ...posts].find((post) => post.id === editingId) ?? null;
  const mode: "now" | "later" = editing ? (editing.published_at ? "now" : "later") : when;
  const showSchedule = !editing || !editing.published_at;
  const scheduledAt = mode === "later" ? coopWallTimeToDate(whenDate, whenTime) : null;

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data, error }, { data: waitingRows }, { data: classRows }, { data: eventRows }] = await Promise.all([
      supabase.from("posts").select(POST_COLUMNS).not("published_at", "is", null).order("created_at", { ascending: false }).limit(40),
      supabase.from("posts").select(POST_COLUMNS).is("published_at", null).order("scheduled_for", { ascending: true, nullsFirst: false }).limit(100),
      supabase.from("classes").select("id,title").order("title"),
      supabase.from("events").select("id,title,description,starts_at,ends_at,location,audience,all_day").is("class_id", null).order("starts_at", { ascending: false }).limit(60),
    ]);
    if (error) return;
    setPosts((data ?? []) as Post[]);
    setWaiting((waitingRows ?? []) as Post[]);
    setClasses((classRows ?? []) as ClassOption[]);
    setEvents((eventRows ?? []) as CalendarEvent[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function removePost(id: string, headline: string, scheduled: boolean) {
    if (!confirm(scheduled
      ? `Delete the scheduled post "${headline}"? It will not go out. This cannot be undone.`
      : `Delete "${headline}"? Families and teachers will no longer see it, and its photos go with it. This cannot be undone.`)) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const { error } = await supabase.from("posts").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    if (editingId === id) cancelEdit();
    setStatus(`Deleted "${headline}".`); await load();
  }

  async function publishNow(post: Post) {
    if (!confirm(`Publish "${post.title}" now? Families will be notified right away.`)) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const { error } = await supabase.rpc("admin_publish_post_now", { p_id: post.id });
    if (error) { setStatus(error.message); return; }
    if (editingId === post.id) cancelEdit();
    setStatus(`Published "${post.title}".`); await load();
  }

  async function cancelSchedule(post: Post) {
    if (!confirm(`Cancel the schedule for "${post.title}"? It will not go out. It stays here as a draft, and you can schedule it again or delete it.`)) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const { error } = await supabase.rpc("admin_cancel_scheduled_post", { p_id: post.id });
    if (error) { setStatus(error.message); return; }
    if (editingId === post.id) cancelEdit();
    setStatus(`Cancelled the schedule for "${post.title}". It is kept as a draft.`); await load();
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    const cleanBody = sanitizeRichText(body);
    if (!supabase) return;
    if (!title.trim()) { setStatus("Give the post a headline."); return; }
    // stripRichText strips every tag, including <img> -- a post that's only
    // an inline image (the editor's own "Image" button) or only an attached
    // file (a flyer with no body text) is real, supported content, so
    // emptiness has to check for those too, not just leftover text, or a
    // photo/attachment-only post silently never published with no
    // explanation why.
    if (!stripRichText(cleanBody) && !inlineImagePaths(cleanBody).length && !files.length && !(attachments[editingId ?? ""]?.length)) { setStatus("Write something, or add a photo or file, before publishing."); return; }
    if (audience === "class" && !classId) { setStatus("Choose which class this is for."); return; }
    if (mode === "later") {
      if (!scheduledAt) { setStatus("Choose the date and time to publish."); return; }
      if (scheduledAt.getTime() <= new Date().getTime()) { setStatus("Choose a time in the future."); return; }
    }
    setBusy(true); setStatus("");

    const uploaded: { path: string; file: File }[] = [];
    for (const file of files) {
      const result = await uploadPrivateFile(supabase, "news", file);
      if ("error" in result) { setStatus(`${file.name}: ${result.error}`); setBusy(false); return; }
      uploaded.push({ path: result.path, file });
    }

    const payload = { title: title.trim(), body: cleanBody, audience, class_id: audience === "class" ? classId || null : null };
    let postId: string;
    if (scheduledAt) {
      // One step in the database: the post is saved with its time, never published, and the change is logged.
      const { data: savedId, error } = await supabase.rpc("admin_save_scheduled_post", {
        p_id: editingId, p_title: payload.title, p_body: payload.body, p_audience: payload.audience, p_class_id: payload.class_id, p_when: scheduledAt.toISOString(),
      });
      if (error || !savedId) { setStatus(error?.message ?? "Could not schedule the post."); setBusy(false); return; }
      postId = savedId as string;
    } else {
      const write = editingId
        ? supabase.from("posts").update(payload).eq("id", editingId).select("id").single()
        : supabase.from("posts").insert({ ...payload, author_user_id: actorUserId, published_at: new Date().toISOString() }).select("id").single();
      const { data: post, error } = await write;
      if (error) { setStatus(error.message); setBusy(false); return; }
      postId = post.id;
    }

    if (uploaded.length) {
      const existingCount = attachments[postId]?.length ?? 0;
      const { error: attachError } = await supabase.from("post_attachments").insert(uploaded.map((item, index) => ({ post_id: postId, storage_path: item.path, file_name: item.file.name, content_type: item.file.type || null, sort_order: existingCount + index })));
      if (attachError) { setStatus(`Saved, but the new files could not be attached: ${attachError.message}`); setBusy(false); await load(); return; }
    }

    const wasEditing = !!editingId;
    const message = scheduledAt
      ? `${wasEditing ? "Schedule updated" : "Scheduled"}: it will go out ${formatCoopDateTime(scheduledAt)}.`
      : wasEditing ? "News item updated." : uploaded.length ? `Published with ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}.` : "Published.";
    setBusy(false); resetComposer(); setStatus(message); await load();
  }

  function resetComposer() {
    const next = defaultSchedule();
    setEditingId(null); setTitle(""); setBody(""); setAudience("families"); setClassId(""); setFiles([]);
    setWhen("now"); setWhenDate(next.date); setWhenTime(next.time);
  }

  function editPost(post: Post) {
    const slot = post.scheduled_for ? coopWallTime(post.scheduled_for) : defaultSchedule();
    setEditingId(post.id); setTitle(post.title); setBody(post.body); setAudience(post.audience); setClassId(post.class_id ?? ""); setFiles([]);
    setWhenDate(slot.date); setWhenTime(slot.time);
    setStatus(`Editing “${post.title}”.`);
  }

  function cancelEdit() {
    resetComposer(); setStatus("");
  }

  const stateLine = (post: Post) => {
    if (post.published_at) return new Date(post.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    if (post.scheduled_for) return `Scheduled for ${formatCoopDateTime(post.scheduled_for)}`;
    return "Draft";
  };

  const renderPost = (post: Post) => <article className="news-item" key={post.id}>
    <PostThumbnail attachments={attachments[post.id] ?? []} />
    <div>
      <b>{post.title}{!post.published_at && <> <span className={`status-pill ${post.scheduled_for ? "pending" : "cancelled"}`}>{post.scheduled_for ? "Scheduled" : "Draft"}</span></>}</b>
      <span>{post.audience} · {stateLine(post)}{(attachments[post.id]?.length ?? 0) > 0 ? ` · ${attachments[post.id].length} file${attachments[post.id].length === 1 ? "" : "s"}` : ""}</span>
      {post.schedule_held_reason && <small className="schedule-held" role="alert">Held: the person who scheduled this is no longer an active administrator, so it did not go out. Publish it, pick a new time, or cancel it.</small>}
      <small>{stripRichText(post.body).slice(0, 150)}</small>
    </div>
    <div className="row-actions">
      <button onClick={() => editPost(post)}>Edit</button>
      {!post.published_at && <button onClick={() => publishNow(post)}>Publish now</button>}
      {!post.published_at && post.scheduled_for && <button className="ghost" onClick={() => cancelSchedule(post)}>Cancel schedule</button>}
      <button className="danger" onClick={() => removePost(post.id, post.title, !post.published_at)}>Delete</button>
    </div>
  </article>;

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
        {showSchedule && <fieldset className="schedule-pick" disabled={busy}>
          <legend className="field-caption">When</legend>
          {!editing && <div className="schedule-choice">
            <label className="checkbox-field"><input type="radio" name="publish-when" checked={when === "now"} onChange={() => setWhen("now")} /> Publish now</label>
            <label className="checkbox-field"><input type="radio" name="publish-when" checked={when === "later"} onChange={() => setWhen("later")} /> Publish later</label>
          </div>}
          {mode === "later" && <>
            <div className="composer-row schedule-boxes">
              <label><span className="field-caption">Date</span><input type="date" required value={whenDate} min={coopWallTime(new Date()).date} onChange={(event) => setWhenDate(event.target.value)} /></label>
              <label><span className="field-caption">Time (Central)</span><input type="time" required value={whenTime} onChange={(event) => setWhenTime(event.target.value)} /></label>
            </div>
            <p className="composer-hint" role="status">{scheduledAt
              ? scheduledAt.getTime() > new Date().getTime() ? `Goes out ${formatCoopDateTime(scheduledAt)}. Until then no one but administrators can see it, and nobody is notified.` : "That time has already passed. Choose a later one."
              : "Choose a date and time."}</p>
          </>}
        </fieldset>}
        {files.length > 0 && <p className="composer-files">{files.length} file{files.length === 1 ? "" : "s"} ready: {files.map((file) => file.name).join(", ")}</p>}
        <div className="row-actions"><button disabled={busy}>{busy ? "Saving…" : editing ? (mode === "later" ? "Save schedule" : "Save changes") : mode === "later" ? "Schedule news" : "Publish news"}</button>{editingId && <button type="button" className="ghost" onClick={cancelEdit} disabled={busy}>Cancel edit</button>}</div><p className="admin-form-status" role="status">{status}</p>
      </form>
      {waiting.length > 0 && <section className="news-waiting" aria-label="Scheduled and draft posts">
        <p className="card-kicker">Waiting to go out</p>
        <div className="news-list">{waiting.map(renderPost)}</div>
      </section>}
      <div className="news-list">{posts.map(renderPost)}{!posts.length && <p>No news published yet.</p>}</div>
    </> : <CalendarPublisher events={events} onSaved={load} onStatus={setStatus} status={status} />}
  </section>;
}

function CalendarPublisher({ events, onSaved, onStatus, status }: { events: CalendarEvent[]; onSaved: () => void; onStatus: (message: string) => void; status: string }) {
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [location, setLocation] = useState("");
  // Most co-op events are a date on the calendar, not a specific meeting time -- all-day is the default, with a toggle for the few that need one.
  const [allDay, setAllDay] = useState(true);
  const [startsAt, setStartsAt] = useState(""); const [endsAt, setEndsAt] = useState(""); const [audience, setAudience] = useState("families"); const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Automatic reminders before the event, on unless this switch is off. The flags and the planned reminders are
  // fetched here so the event list above this form does not need to know about them.
  const [sendReminders, setSendReminders] = useState(true);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [planned, setPlanned] = useState<Record<string, ReminderRow[]>>({});

  async function loadReminders() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const ids = events.map((row) => row.id);
    const [{ data: flagRows }, { data: plannedRows }] = await Promise.all([
      ids.length ? supabase.from("events").select("id,send_reminders").in("id", ids) : Promise.resolve({ data: [] }),
      supabase.rpc("admin_upcoming_event_reminders", { p_days: 60 }),
    ]);
    setFlags(Object.fromEntries(((flagRows ?? []) as { id: string; send_reminders: boolean }[]).map((row) => [row.id, row.send_reminders])));
    const grouped: Record<string, ReminderRow[]> = {};
    for (const row of (plannedRows ?? []) as ReminderRow[]) (grouped[row.event_id] ??= []).push(row);
    setPlanned(grouped);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- reload the reminder schedule whenever the event list changes
  useEffect(() => { void loadReminders(); }, [events]);

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
      all_day: allDay, audience, class_id: null, send_reminders: sendReminders,
    };
    const { error } = editingId
      ? await supabase.from("events").update(payload).eq("id", editingId)
      : await supabase.from("events").insert(payload);
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    onStatus(editingId ? `Updated ${title.trim()}.` : `Added ${title.trim()} to the Village calendar.`); setTitle(""); setDescription(""); setLocation(""); setStartsAt(""); setEndsAt(""); setAllDay(true); setAudience("families"); setSendReminders(true); setEditingId(null); onSaved();
  }

  function editEvent(row: CalendarEvent) {
    setEditingId(row.id); setTitle(row.title); setDescription(row.description ?? ""); setLocation(row.location ?? "");
    setAllDay(row.all_day);
    setStartsAt(row.all_day ? inputDate(row.starts_at) : inputDateTime(row.starts_at));
    setEndsAt(row.all_day ? inputDate(row.ends_at) : inputDateTime(row.ends_at));
    setAudience(row.audience); setSendReminders(flags[row.id] ?? true); onStatus(`Editing “${row.title}”.`);
  }

  function cancelEdit() {
    setEditingId(null); setTitle(""); setDescription(""); setLocation(""); setStartsAt(""); setEndsAt(""); setAllDay(true); setAudience("families"); setSendReminders(true); onStatus("");
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

  return <>
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
    <label className="checkbox-field"><input type="checkbox" checked={sendReminders} onChange={(event) => setSendReminders(event.target.checked)} disabled={busy} /> Send reminders before this event (3 days and 1 day, unless you changed that in Integrations). Everyone who can see the event gets one.</label>
    <div className="row-actions"><button disabled={busy}>{busy ? "Saving…" : editingId ? "Save event" : "Add calendar event"}</button>{editingId && <button type="button" className="ghost" onClick={cancelEdit} disabled={busy}>Cancel edit</button>}</div><p className="admin-form-status" role="status">{status}</p>
  </form><div className="news-list calendar-admin-list">{events.map((row) => <article className="news-item" key={row.id}><time>{new Date(row.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: row.all_day ? "UTC" : undefined })}</time><div><b>{row.title}</b><span>{row.all_day ? "All day" : new Date(row.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}{row.location ? ` · ${row.location}` : ""} · {row.audience}</span>{flags[row.id] === false ? <small>Reminders are off for this event.</small> : (planned[row.id] ?? []).map((reminder) => <small key={reminder.offset_days} className={reminder.status === "skipped" ? "reminder-skipped" : undefined}>{reminderLine(reminder)}</small>)}</div><div className="row-actions"><button onClick={() => editEvent(row)}>Edit</button><button className="danger" onClick={() => removeEvent(row)}>Delete</button></div></article>)}{!events.length && <p className="portal-empty">No co-op-wide events have been added yet.</p>}</div>
  <SubscribeLink query="scope=public" label="Subscribe to this calendar" />
  </>;
}
