"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import SubscribeLink, { PersonalSubscribeLink } from "../subscribe-link";
import { getSignedFileUrl, getSignedFileUrls, uploadPrivateFile } from "../../../lib/storage";
import { usePortalAccess } from "../../../lib/use-portal-access";
import MfaChallengeScreen from "../mfa-challenge";
import Avatar from "../avatar";
import AppHeader from "../app-header";
import DetailModal from "../detail-modal";
import NewsSection from "./news-section";
import { ClassSchedule, SCHEDULE_SELECT, describeSchedule } from "../../../lib/schedule";

type ClassRow = { id: string; title: string; description: string | null } & ClassSchedule;
type Assignment = { class_id: string; assignment_role: string; classes: ClassRow };
type RosterChild = { id: string; first_name: string; last_name: string | null; class_id: string; avatar_path: string | null };
type NoteRead = { name: string; read_at: string };
type Note = { id: string; body: string; visibility: string; created_at: string; child_id: string; class_id: string; author_user_id: string; author_name: string; reads: NoteRead[] };
type Handout = { id: string; title: string; kind: string; storage_path: string; class_id: string | null; created_at: string };
type PrintRequest = { id: string; title: string; quantity: number; status: string; storage_path: string; created_at: string; class_id: string | null };
type ClassEvent = { id: string; class_id: string | null; title: string; description: string | null; starts_at: string; location: string | null; requires_prework: boolean; audience: string };

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

function noteCountLabel(count: number) {
  if (!count) return "no notes";
  return count === 1 ? "1 note" : `${count} notes`;
}

function formatDay(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Unlike formatDay, this is a real timestamptz -- shown in the reader's own
    local time, not pinned to UTC, since "read at 3:15" should mean their 3:15. */
function formatReadTime(value: string) {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function summarizeReads(reads: { name: string; read_at: string }[]): string | null {
  if (!reads.length) return null;
  const latest = reads[reads.length - 1];
  const rest = reads.length - 1;
  return `Read by ${latest.name} on ${formatReadTime(latest.read_at)}${rest ? ` · +${rest} more` : ""}`;
}

export default function TeacherWorkspace() {
  const { state: access, userId, roles, recheck } = usePortalAccess("teacher");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  /** class_id -> 'lead' | 'assistant'. Assistants are shown a smaller page. */
  const [roleByClass, setRoleByClass] = useState<Record<string, string>>({});
  const [activeClassId, setActiveClassId] = useState("");
  const [roster, setRoster] = useState<RosterChild[]>([]);
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [notes, setNotes] = useState<Note[]>([]);
  const [handouts, setHandouts] = useState<Handout[]>([]);
  const [printQueue, setPrintQueue] = useState<PrintRequest[]>([]);
  const [classEvents, setClassEvents] = useState<ClassEvent[]>([]);
  const [openChildId, setOpenChildId] = useState<string | null>(null);

  async function loadAll(uid: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: assignments } = await supabase.from("teacher_assignments")
      .select(`class_id,assignment_role,classes(id,title,description,${SCHEDULE_SELECT})`).eq("user_id", uid);
    const rows = (assignments ?? []) as unknown as Assignment[];
    const myClasses = rows.map((row) => row.classes).filter(Boolean);
    setClasses(myClasses);
    setRoleByClass(Object.fromEntries(rows.map((row) => [row.class_id, row.assignment_role])));
    setActiveClassId((current) => current || myClasses[0]?.id || "");
    const classIds = myClasses.map((row) => row.id);
    if (!classIds.length) return;

    const [{ data: enrollments }, { data: noteRows }, { data: handoutRows }, { data: printRows }, { data: eventRows }, { data: villageEventRows }] = await Promise.all([
      supabase.from("enrollments").select("child_id,class_id,children(id,first_name,last_name,avatar_path)").in("class_id", classIds).eq("status", "active"),
      supabase.from("teacher_notes").select("id,body,visibility,created_at,child_id,class_id,author_user_id").in("class_id", classIds).order("created_at", { ascending: false }).limit(60),
      supabase.from("documents").select("id,title,kind,storage_path,class_id,created_at").in("class_id", classIds).order("created_at", { ascending: false }),
      supabase.from("print_requests").select("id,title,quantity,status,storage_path,created_at,class_id").eq("requested_by_user_id", uid).is("cleared_at", null).order("created_at", { ascending: false }),
      supabase.from("events").select("id,class_id,title,description,starts_at,location,requires_prework,audience").in("class_id", classIds).order("starts_at", { ascending: true }),
      supabase.from("events").select("id,class_id,title,description,starts_at,location,requires_prework,audience").is("class_id", null).order("starts_at", { ascending: true }),
    ]);
    const rosterRows = ((enrollments ?? []) as unknown as { children: { id: string; first_name: string; last_name: string | null; avatar_path: string | null }; class_id: string }[])
      .map((row) => ({ ...row.children, class_id: row.class_id }));
    setRoster(rosterRows);
    const avatarPaths = rosterRows.map((row) => row.avatar_path).filter((path): path is string => !!path);
    if (avatarPaths.length) setAvatarUrls(await getSignedFileUrls(supabase, avatarPaths));

    const noteBase = (noteRows ?? []) as Omit<Note, "author_name" | "reads">[];
    const authorIds = [...new Set(noteBase.map((row) => row.author_user_id))];
    const noteIds = noteBase.map((row) => row.id);
    const [{ data: authorRows }, { data: readRows }] = await Promise.all([
      authorIds.length ? supabase.from("profiles").select("id,display_name,email").in("id", authorIds) : Promise.resolve({ data: [] }),
      // read_at is what makes this a receipt rather than a bare tally -- a
      // teacher asking "did the Smules see this" wants to know when, not just
      // that someone, at some point, did.
      noteIds.length ? supabase.from("teacher_note_reads").select("note_id,read_at,profiles(display_name,email)").in("note_id", noteIds) : Promise.resolve({ data: [] }),
    ]);
    const authorMap = new Map((authorRows ?? []).map((row) => [row.id, row.display_name || row.email]));
    const reads = new Map<string, NoteRead[]>();
    ((readRows ?? []) as unknown as { note_id: string; read_at: string; profiles: { display_name: string | null; email: string } | null }[])
      .forEach((row) => {
        const name = row.profiles?.display_name || row.profiles?.email || "A family member";
        reads.set(row.note_id, [...(reads.get(row.note_id) ?? []), { name, read_at: row.read_at }]);
      });
    setNotes(noteBase.map((row) => ({
      ...row, author_name: authorMap.get(row.author_user_id) ?? "Teacher",
      reads: (reads.get(row.id) ?? []).sort((a, b) => a.read_at.localeCompare(b.read_at)),
    })));

    setHandouts((handoutRows ?? []) as Handout[]);
    setPrintQueue((printRows ?? []) as PrintRequest[]);
    setClassEvents([...(eventRows ?? []), ...(villageEventRows ?? [])] as ClassEvent[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch once access resolves
  useEffect(() => { if (access === "ready" && userId) loadAll(userId); }, [access, userId]);

  async function deleteNote(noteId: string) {
    if (!confirm("Delete this note? This cannot be undone.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("teacher_notes").delete().eq("id", noteId);
    if (!error) await loadAll(userId);
  }

  if (access === "loading") return <main className="portal-state"><p className="eyebrow">Teacher workspace</p><h1>Gathering your classes…</h1></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private teacher workspace</p><h1>Teacher access is required.</h1><a href="/family-village">Return to Family Village →</a></main>;

  const activeClass = classes.find((row) => row.id === activeClassId);
  const classRoster = roster.filter((child) => child.class_id === activeClassId);
  const openChild = classRoster.find((child) => child.id === openChildId) ?? null;
  // A lead runs the class; an assistant helps with it. The page only offers what
  // the row-level policies would actually accept, so nobody meets a denied write.
  const isLead = roleByClass[activeClassId] === "lead";
  const reload = () => loadAll(userId);

  return <main className="workspace-preview">
    <AppHeader current="teacher" roles={roles} title="Teacher’s Lounge" subtitle="Your classes, roster, and resources in one place." />
    <div className="preview-banner"><b>Only your assigned classes are shown.</b> Families and students outside your roster stay private.</div>
    {!classes.length && <p className="portal-empty portal-empty-standalone">No classes are assigned to you yet. A Village administrator can assign you to a class.</p>}

    {classes.length > 0 && <section className="workspace-grid">
      <article className="workspace-nav">
        <a className="active" href="#news">Teaching team news</a>
        <a href="#calendar">Calendar</a>
        <a href="#classes">Classes</a>
        <a href="#planning">Class dates</a>
        <a href="#resources">Class files</a>
        <a href="#lounge">Print queue</a>
      </article>

      <div className="workspace-main">
        <NewsSection classes={classes} />

        <TeacherCalendar events={classEvents} classes={classes} roleByClass={roleByClass} activeClassId={activeClassId} userId={userId} onSaved={reload} />

        {/* One class selection drives the whole page. Every section below is
            scoped to it, so the per-section class dropdowns are gone. */}
        <section id="classes">
          <p className="card-kicker">My classes</p>
          <h2>Your classroom, organized.</h2>
          <div className="teacher-class-list">
            {classes.map((row) => <div
              className={`teacher-class clickable${row.id === activeClassId ? " active" : ""}`}
              key={row.id} role="button" tabIndex={0}
              onClick={() => { setActiveClassId(row.id); setOpenChildId(null); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveClassId(row.id); setOpenChildId(null); } }}>
              <div>
                <b>{row.title}</b>
                <span>{describeSchedule(row)}{roleByClass[row.id] === "assistant" ? " · assisting" : ""}</span>
              </div>
            </div>)}
          </div>

          {activeClass && <div className="class-roster">
            <p className="card-kicker">Students in {activeClass.title}</p>
            {/* Notes stay closed until a student is chosen -- one child's record
                should not be on screen while another parent is at the desk. */}
            {classRoster.length
              ? <ul className="roster-list roster-pickable">
                  {classRoster.map((child) => <li key={child.id}>
                    <button
                      className={`roster-pick${child.id === openChildId ? " active" : ""}`}
                      aria-expanded={child.id === openChildId}
                      onClick={() => setOpenChildId(child.id === openChildId ? null : child.id)}>
                      <Avatar url={child.avatar_path ? avatarUrls.get(child.avatar_path) ?? null : null} label={child.first_name} size="sm" />
                      <span className="roster-pick-name">{child.first_name} {child.last_name}</span>
                      <span className="roster-note-count">{noteCountLabel(notes.filter((n) => n.child_id === child.id && n.class_id === activeClassId).length)}</span>
                    </button>
                  </li>)}
                </ul>
              : <p className="portal-empty">No students enrolled in this class yet.</p>}

            {openChild && <StudentNotes
              child={openChild}
              classId={activeClassId}
              notes={notes.filter((note) => note.child_id === openChild.id && note.class_id === activeClassId)}
              userId={userId}
              onSaved={reload}
              onDelete={deleteNote}
              onClose={() => setOpenChildId(null)}
            />}
          </div>}
        </section>

        {activeClass && <ClassDatesSection
          klass={activeClass} isLead={isLead}
          events={classEvents.filter((row) => row.class_id === activeClassId)}
          onSaved={reload}
        />}

        {activeClass && <ResourcesSection
          klass={activeClass} isLead={isLead} userId={userId}
          handouts={handouts.filter((row) => row.class_id === activeClassId)}
          onSaved={reload}
        />}

        {activeClass && <PrintSection
          klass={activeClass} isLead={isLead} userId={userId}
          queue={printQueue} classes={classes} onSaved={reload}
        />}
      </div>
    </section>}
  </main>;
}

/**
 * A lead teacher schedules curriculum by attaching dated, class-scoped events
 * directly here -- "requires prework" is what makes a date an assignment
 * families see a checkbox for (child-detail.tsx / portal-gate.tsx already
 * read that flag). Nothing new to build there; this just gives a lead
 * teacher a way to create/edit/delete their own class's events, which the
 * RLS policy events_teacher_write already allows and this calendar simply
 * didn't expose.
 *
 * Read-only for an assistant, and for any event on a class this teacher
 * doesn't lead (a village-wide event, or a class they only assist with) --
 * clicking those does nothing, matching what they're actually allowed to
 * write.
 */
type CalendarView = "list" | "day" | "week" | "month";
const CALENDAR_VIEWS: { id: CalendarView; label: string }[] = [
  { id: "list", label: "List" }, { id: "day", label: "Day" }, { id: "week", label: "Week" }, { id: "month", label: "Month" },
];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfWeek(date: Date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

/**
 * A lead teacher schedules curriculum by attaching dated, class-scoped events
 * directly here -- "requires prework" is what makes a date an assignment
 * families see a checkbox for (child-detail.tsx / portal-gate.tsx already
 * read that flag). Nothing new to build there; this just gives a lead
 * teacher a way to create/edit/delete their own class's events, which the
 * RLS policy events_teacher_write already allows and this calendar simply
 * didn't expose.
 *
 * Read-only for an assistant, and for any event on a class this teacher
 * doesn't lead (a village-wide event, or a class they only assist with) --
 * those render as disabled rather than doing nothing on click, so it's
 * visible rather than a dead end.
 *
 * List is the default view -- "what's coming up" is the question most days;
 * Day/Week/Month share one cursor date, so switching between them keeps
 * whatever day you were looking at in view.
 */
function TeacherCalendar({ events, classes, roleByClass, activeClassId, userId, onSaved }: {
  events: ClassEvent[]; classes: ClassRow[]; roleByClass: Record<string, string>; activeClassId: string; userId: string; onSaved: () => void;
}) {
  const today = new Date();
  const [view, setView] = useState<CalendarView>("list");
  const [cursor, setCursor] = useState(today);
  const [editing, setEditing] = useState<{ date: string; classId: string; event: ClassEvent | null } | null>(null);
  const activeLead = roleByClass[activeClassId] === "lead";
  const activeClassTitle = classes.find((klass) => klass.id === activeClassId)?.title ?? "";
  const editingClass = editing ? classes.find((klass) => klass.id === editing.classId) : null;

  const eventsFor = (day: Date) => events.filter((event) => dateKey(new Date(event.starts_at)) === dateKey(day));
  const classTitle = (id: string | null) => classes.find((klass) => klass.id === id)?.title;
  const canEdit = (event: ClassEvent) => !!event.class_id && roleByClass[event.class_id] === "lead";

  function openDay(day: Date) {
    if (!activeLead) return;
    setEditing({ date: dateKey(day), classId: activeClassId, event: null });
  }

  function openEvent(event: ClassEvent) {
    if (!canEdit(event)) return;
    setEditing({ date: dateKey(new Date(event.starts_at)), classId: event.class_id!, event });
  }

  function step(amount: number) {
    if (view === "day") setCursor((current) => { const next = new Date(current); next.setDate(next.getDate() + amount); return next; });
    else if (view === "week") setCursor((current) => { const next = new Date(current); next.setDate(next.getDate() + amount * 7); return next; });
    else setCursor((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  }

  function eventChip(event: ClassEvent) {
    const editable = canEdit(event);
    return <button
      key={event.id} type="button" className="calendar-event-chip" disabled={!editable}
      title={[event.title, classTitle(event.class_id), event.location].filter(Boolean).join(" · ")}
      onClick={() => openEvent(event)}
    ><strong>{event.title}</strong>{classTitle(event.class_id) && <small>{classTitle(event.class_id)}</small>}</button>;
  }

  function dayCell(day: Date, key: string, extraClass = "") {
    return <div key={key} role="gridcell" className={`${extraClass}${dateKey(day) === dateKey(today) ? " today" : ""}`}>
      <div className="calendar-day-head">
        <time dateTime={dateKey(day)}>{day.getDate()}</time>
        {activeLead && <button type="button" className="ghost calendar-add" aria-label={`Schedule something for ${activeClassTitle} on ${dateKey(day)}`} onClick={() => openDay(day)}>+</button>}
      </div>
      {eventsFor(day).map(eventChip)}
    </div>;
  }

  const heading = view === "list" ? "What's coming up"
    : view === "day" ? cursor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : view === "week" ? `Week of ${startOfWeek(cursor).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`
    : cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return <section id="calendar" className="teacher-calendar">
    <div className="teacher-calendar-head">
      <div><p className="card-kicker">Calendar</p><h2>{heading}</h2></div>
      {view !== "list" && <div className="row-actions">
        <button className="ghost" aria-label={`Previous ${view}`} onClick={() => step(-1)}>←</button>
        <button className="ghost" onClick={() => setCursor(today)}>Today</button>
        <button className="ghost" aria-label={`Next ${view}`} onClick={() => step(1)}>→</button>
      </div>}
    </div>
    <div className="publishing-switch" role="tablist" aria-label="Calendar view">
      {CALENDAR_VIEWS.map((option) => <button key={option.id} role="tab" aria-selected={view === option.id} className={view === option.id ? "active" : ""} onClick={() => setView(option.id)}>{option.label}</button>)}
    </div>
    {activeLead && view !== "list" && <p className="composer-hint">Click + on a day to schedule curriculum or an assignment for {activeClassTitle}.</p>}

    {view === "list" && <div className="calendar-list-view">
      {activeLead && <button type="button" className="ghost" onClick={() => openDay(today)} style={{ marginBottom: 12 }}>+ Schedule something for {activeClassTitle}</button>}
      {events.length
        ? events.map((event) => <button key={event.id} type="button" className="calendar-list-item" disabled={!canEdit(event)} onClick={() => openEvent(event)}>
            <time>{new Date(event.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</time>
            <div><b>{event.title}</b><span>{[classTitle(event.class_id), event.location].filter(Boolean).join(" · ")}</span></div>
          </button>)
        : <p className="portal-empty">Nothing scheduled yet.</p>}
    </div>}

    {view === "day" && <div className="month-calendar calendar-day-view" role="grid" aria-label={heading}>
      {dayCell(cursor, "day")}
    </div>}

    {view === "week" && <div className="month-calendar" role="grid" aria-label={heading}>
      {WEEKDAY_NAMES.map((day) => <b key={day} role="columnheader">{day}</b>)}
      {Array.from({ length: 7 }, (_, index) => { const day = new Date(startOfWeek(cursor)); day.setDate(day.getDate() + index); return day; })
        .map((day) => dayCell(day, dateKey(day), "calendar-week-cell"))}
    </div>}

    {view === "month" && <div className="month-calendar" role="grid" aria-label={heading}>
      {WEEKDAY_NAMES.map((day) => <b key={day} role="columnheader">{day}</b>)}
      {(() => {
        const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
        const gridStart = startOfWeek(first);
        return Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(gridStart.getDate() + index); return day; })
          .map((day) => dayCell(day, day.toISOString(), day.getMonth() === cursor.getMonth() ? "" : "outside"));
      })()}
    </div>}

    <div className="calendar-subscribe-row">
      <PersonalSubscribeLink userId={userId} />
      {activeClassId && <SubscribeLink query={`scope=class&id=${activeClassId}`} label={`Subscribe to ${activeClassTitle}’s calendar`} />}
    </div>

    {editing && editingClass && <EventEditor
      classId={editing.classId} classTitle={editingClass.title} date={editing.date} event={editing.event}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved(); }}
    />}
  </section>;
}

function EventEditor({ classId, classTitle, date, event, onClose, onSaved }: {
  classId: string; classTitle: string; date: string; event: ClassEvent | null; onClose: () => void; onSaved: () => void;
}) {
  const [when, setWhen] = useState(date);
  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [requiresPrework, setRequiresPrework] = useState(event?.requires_prework ?? false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function save(formEvent: FormEvent) {
    formEvent.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !when) return;
    setBusy(true); setStatus("");
    const payload = {
      title: title.trim(), description: description.trim() || null, location: location.trim() || null,
      requires_prework: requiresPrework, audience: "class", class_id: classId,
      // Class dates are date-only -- a teacher scheduling curriculum is
      // marking a day, not booking a specific meeting time.
      starts_at: `${when}T00:00:00.000Z`, ends_at: null, all_day: true,
    };
    const { error } = event
      ? await supabase.from("events").update(payload).eq("id", event.id)
      : await supabase.from("events").insert(payload);
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    onSaved();
  }

  async function remove() {
    if (!event || !confirm(`Remove "${event.title}" from the calendar?`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.from("events").delete().eq("id", event.id);
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    onSaved();
  }

  return <DetailModal title={classTitle} onClose={onClose}>
    <form onSubmit={save} className="portal-form">
      <label><span className="field-caption">Date</span>
        <input required type="date" value={when} onChange={(domEvent) => setWhen(domEvent.target.value)} disabled={busy} />
      </label>
      <label><span className="field-caption">What&rsquo;s scheduled</span>
        <input required value={title} onChange={(domEvent) => setTitle(domEvent.target.value)} placeholder="Chapter 4 reading" disabled={busy} />
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={requiresPrework} onChange={(domEvent) => setRequiresPrework(domEvent.target.checked)} disabled={busy} />
        Students need to prepare before this (shows as an assignment families can check off)
      </label>
      <label><span className="field-caption">Notes <i>optional</i></span>
        <textarea value={description} onChange={(domEvent) => setDescription(domEvent.target.value)} placeholder="What to bring, what to read, ..." disabled={busy} />
      </label>
      <label><span className="field-caption">Location <i>optional</i></span>
        <input value={location} onChange={(domEvent) => setLocation(domEvent.target.value)} disabled={busy} />
      </label>
      <div className="row-actions">
        <button disabled={busy}>{busy ? "Saving…" : event ? "Save changes" : "Add to calendar"}</button>
        {event && <button type="button" className="danger" onClick={remove} disabled={busy}>Remove</button>}
      </div>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
  </DetailModal>;
}

/** One student's notes, plus the form to add another. Only rendered on demand. */
function StudentNotes({ child, classId, notes, userId, onSaved, onDelete, onClose }: {
  child: RosterChild; classId: string; notes: Note[]; userId: string;
  onSaved: () => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState("family");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !body.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("teacher_notes").insert({
      child_id: child.id, class_id: classId, author_user_id: userId, body: body.trim(), visibility,
    });
    setBusy(false);
    if (!error) { setBody(""); onSaved(); }
  }

  return <div className="student-notes">
    <div className="student-notes-head">
      <div>
        <p className="card-kicker">Notes</p>
        <h3>{child.first_name} {child.last_name}</h3>
      </div>
      <button className="ghost" onClick={onClose}>Close</button>
    </div>

    <div className="note-rules"><span>Family visible</span><span>Teaching team only</span><span>Administrators only</span></div>

    <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">Note</span>
        <textarea required value={body} onChange={(event) => setBody(event.target.value)} placeholder="Progress, behavior, or a note home" disabled={busy} />
      </label>
      <label><span className="field-caption">Visible to</span>
        <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
          <option value="family">Family</option>
          <option value="teachers">Teaching team only</option>
          <option value="admins">Administrators only</option>
        </select>
      </label>
      <button disabled={busy}>{busy ? "Saving…" : "Save note"}</button>
    </form>

    <div className="portal-stack">
      {notes.map((note) => <div key={note.id} className="note-card">
        <span className="note-meta">{note.author_name} · {note.visibility} · {formatDay(note.created_at)}{summarizeReads(note.reads) ? ` · ${summarizeReads(note.reads)}` : " · Not read yet"}</span>
        <p>{note.body}</p>
        {note.author_user_id === userId && <button className="danger" onClick={() => onDelete(note.id)}>Delete</button>}
      </div>)}
      {!notes.length && <p className="portal-empty">No notes for {child.first_name} in this class yet.</p>}
    </div>
  </div>;
}

/**
 * Class dates: what is being worked on, when, where, and whether families need
 * to do something first.
 *
 * Homework used to be a second form of its own. It is folded in here as a flag,
 * because a teacher setting the week's topic and a teacher setting pre-work are
 * the same act -- and a date carrying "prep needed" tells a parent more than a
 * homework row with a due date does.
 *
 * Deliberately date-only. A co-op class has a day, not a start time, and asking
 * for one produced times nobody meant.
 */
function ClassDatesSection({ klass, isLead, events, onSaved }: {
  klass: ClassRow; isLead: boolean; events: ClassEvent[]; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [on, setOn] = useState("");
  const [location, setLocation] = useState("");
  const [instructions, setInstructions] = useState("");
  const [requiresPrework, setRequiresPrework] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !on) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.from("events").insert({
      class_id: klass.id,
      audience: "class",
      title: title.trim(),
      description: instructions.trim() || null,
      // Stored at midday UTC so the date cannot slide either side of midnight
      // when it is read back in Central Time.
      starts_at: new Date(`${on}T12:00:00Z`).toISOString(),
      location: location.trim() || null,
      requires_prework: requiresPrework,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setOn(""); setLocation(""); setInstructions(""); setRequiresPrework(false);
    setStatus("Added. Families in this class can see it now.");
    onSaved();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove "${name}"? Families will no longer see it.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    onSaved();
  }

  return <section id="planning">
    <p className="card-kicker">Class dates</p>
    <h2>What&rsquo;s coming up in {klass.title}.</h2>
    <p className="portal-empty">
      Only the families with a child in {klass.title} see these. They do not go on the co-op calendar.
    </p>

    {isLead ? <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">What are you working on?</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Rock layers and fossils" disabled={busy} />
      </label>
      <label><span className="field-caption">Date</span>
        <input required type="date" value={on} onChange={(event) => setOn(event.target.value)} disabled={busy} />
      </label>
      <label><span className="field-caption">Where <i>optional</i></span>
        <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Room 2" disabled={busy} />
      </label>
      <label><span className="field-caption">Instructions <i>optional</i></span>
        <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="What families should know, or what to bring" disabled={busy} />
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={requiresPrework} onChange={(event) => setRequiresPrework(event.target.checked)} />
        Families need to do something before this class
      </label>
      <button disabled={busy}>{busy ? "Saving…" : "Add class date"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form> : <p className="portal-empty">The lead teacher for {klass.title} sets class dates.</p>}

    <div className="portal-stack">
      {events.map((row) => <div key={row.id} className="teacher-class">
        <div>
          <b>{row.title}</b>
          <span>{[formatDay(row.starts_at), row.location, row.description].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="row-actions">
          {row.requires_prework && <span className="status-pill outstanding">Prep needed</span>}
          {isLead && <button className="danger" onClick={() => remove(row.id, row.title)}>Remove</button>}
        </div>
      </div>)}
      {!events.length && <p className="portal-empty">Nothing scheduled for {klass.title} yet.</p>}
    </div>
  </section>;
}

function ResourcesSection({ klass, isLead, userId, handouts, onSaved }: {
  klass: ClassRow; isLead: boolean; userId: string; handouts: Handout[]; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("handout");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "handouts", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("documents").insert({
      class_id: klass.id, kind, title: title.trim(), storage_path: uploaded.path, uploaded_by_user_id: userId,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setKind("handout"); setStatus("File posted.");
    onSaved();
  }

  async function download(path: string) {
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return <section id="resources">
    <p className="card-kicker">Class files</p>
    <h2>Handouts &amp; curriculum for {klass.title}.</h2>

    {isLead ? <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">Title</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Week 4 spelling list" disabled={busy} />
      </label>
      <label><span className="field-caption">File type</span><select value={kind} onChange={(event) => setKind(event.target.value)} disabled={busy}><option value="handout">Family handout</option><option value="curriculum">Curriculum / teacher resource</option></select></label>
      <label className="file-drop"><span className="field-caption">File</span>
        <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <button disabled={busy}>{busy ? "Uploading…" : "Upload class file"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form> : <p className="portal-empty">The lead teacher for {klass.title} manages class files.</p>}

    <div className="portal-stack portal-stack-tight">
      {handouts.map((handout) => <div key={handout.id} className="teacher-class">
        <div><b>{handout.title}</b><span>{handout.kind === "curriculum" ? "Curriculum" : "Handout"} · {formatDay(handout.created_at)}</span></div>
        <button onClick={() => download(handout.storage_path)}>Open</button>
      </div>)}
      {!handouts.length && <p className="portal-empty">No class files posted for {klass.title} yet.</p>}
    </div>
  </section>;
}

function PrintSection({ klass, isLead, userId, queue, classes, onSaved }: {
  klass: ClassRow; isLead: boolean; userId: string;
  queue: PrintRequest[]; classes: ClassRow[]; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  /** Printing genuinely isn't always for a class, so this stays -- as a
      checkbox rather than another class dropdown. */
  const [forThisClass, setForThisClass] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "print-requests", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("print_requests").insert({
      class_id: forThisClass ? klass.id : null, requested_by_user_id: userId,
      title: title.trim(), storage_path: uploaded.path, quantity,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setQuantity(1); setStatus("Sent to the print queue.");
    onSaved();
  }

  const classTitle = (id: string | null) => classes.find((row) => row.id === id)?.title;

  return <section id="lounge">
    <p className="card-kicker">Print queue</p>
    <h2>Printing for {klass.title}.</h2>

    {isLead ? <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">What is it?</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Class worksheet packet" disabled={busy} />
      </label>
      <label><span className="field-caption">Copies needed</span>
        <input required type="number" min={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={busy} />
      </label>
      <label className="file-drop"><span className="field-caption">File to print</span>
        <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={forThisClass} onChange={(event) => setForThisClass(event.target.checked)} />
        This printing is for {klass.title}
      </label>
      <button disabled={busy}>{busy ? "Sending…" : `Send to print queue`}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form> : <p className="portal-empty">The lead teacher for {klass.title} sends print requests.</p>}

    {/* The list is everything this teacher has queued, across every class --
        not just the selected one. Someone printing for three classes needs to
        see the whole pile in one place, each row saying which class it is for. */}
    <div className="print-queue">
      <p className="card-kicker">Everything you have queued</p>
      {queue.map((item) => <div className="print-item" key={item.id}>
        <div>
          <b>{item.title}</b>
          <span>{[classTitle(item.class_id) ?? "Not class-specific", `${item.quantity} copies`, `requested ${formatDay(item.created_at)}`].join(" · ")}</span>
        </div>
        <span className={`status-pill ${item.status}`}>{item.status}</span>
      </div>)}
      {!queue.length && <p className="portal-empty">Nothing in your print queue.</p>}
      <p className="print-queue-note">Completed jobs leave the queue during the weekly print-room reset.</p>
    </div>
  </section>;
}
