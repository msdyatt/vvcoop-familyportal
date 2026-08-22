"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../../lib/storage";
import { usePortalAccess } from "../../../lib/use-portal-access";
import MfaChallengeScreen from "../mfa-challenge";
import AppHeader from "../app-header";
import NewsSection from "./news-section";

type ClassRow = { id: string; title: string; description: string | null; meeting_time: string | null };
type Assignment = { class_id: string; assignment_role: string; classes: ClassRow };
type RosterChild = { id: string; first_name: string; last_name: string | null; class_id: string };
type Note = { id: string; body: string; visibility: string; created_at: string; child_id: string; class_id: string; author_user_id: string; author_name: string; read_count: number };
type Handout = { id: string; title: string; storage_path: string; class_id: string | null; created_at: string };
type PrintRequest = { id: string; title: string; quantity: number; status: string; storage_path: string; created_at: string };
type Homework = { id: string; class_id: string; title: string; instructions: string | null; due_at: string | null; published_at: string | null };
type ClassEvent = { id: string; class_id: string | null; title: string; description: string | null; starts_at: string; location: string | null };

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

export default function TeacherWorkspace() {
  const { state: access, userId, roles, recheck } = usePortalAccess("teacher");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  /** class_id -> 'lead' | 'assistant'. Assistants are shown a smaller page. */
  const [roleByClass, setRoleByClass] = useState<Record<string, string>>({});
  const [activeClassId, setActiveClassId] = useState("");
  const [roster, setRoster] = useState<RosterChild[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [handouts, setHandouts] = useState<Handout[]>([]);
  const [printQueue, setPrintQueue] = useState<PrintRequest[]>([]);
  const [homework, setHomework] = useState<Homework[]>([]);
  const [classEvents, setClassEvents] = useState<ClassEvent[]>([]);
  const [openChildId, setOpenChildId] = useState<string | null>(null);

  async function loadAll(uid: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: assignments } = await supabase.from("teacher_assignments")
      .select("class_id,assignment_role,classes(id,title,description,meeting_time)").eq("user_id", uid);
    const rows = (assignments ?? []) as unknown as Assignment[];
    const myClasses = rows.map((row) => row.classes).filter(Boolean);
    setClasses(myClasses);
    setRoleByClass(Object.fromEntries(rows.map((row) => [row.class_id, row.assignment_role])));
    setActiveClassId((current) => current || myClasses[0]?.id || "");
    const classIds = myClasses.map((row) => row.id);
    if (!classIds.length) return;

    const [{ data: enrollments }, { data: noteRows }, { data: handoutRows }, { data: printRows }, { data: homeworkRows }, { data: eventRows }] = await Promise.all([
      supabase.from("enrollments").select("child_id,class_id,children(id,first_name,last_name)").in("class_id", classIds).eq("status", "active"),
      supabase.from("teacher_notes").select("id,body,visibility,created_at,child_id,class_id,author_user_id").in("class_id", classIds).order("created_at", { ascending: false }).limit(60),
      supabase.from("documents").select("id,title,storage_path,class_id,created_at").in("class_id", classIds).order("created_at", { ascending: false }),
      supabase.from("print_requests").select("id,title,quantity,status,storage_path,created_at").eq("requested_by_user_id", uid).order("created_at", { ascending: false }),
      supabase.from("assignments").select("id,class_id,title,instructions,due_at,published_at").in("class_id", classIds).order("due_at", { ascending: true }),
      supabase.from("events").select("id,class_id,title,description,starts_at,location").in("class_id", classIds).order("starts_at", { ascending: true }),
    ]);
    setRoster(((enrollments ?? []) as unknown as { children: { id: string; first_name: string; last_name: string | null }; class_id: string }[])
      .map((row) => ({ ...row.children, class_id: row.class_id })));

    const noteBase = (noteRows ?? []) as Omit<Note, "author_name" | "read_count">[];
    const authorIds = [...new Set(noteBase.map((row) => row.author_user_id))];
    const noteIds = noteBase.map((row) => row.id);
    const [{ data: authorRows }, { data: readRows }] = await Promise.all([
      authorIds.length ? supabase.from("profiles").select("id,display_name,email").in("id", authorIds) : Promise.resolve({ data: [] }),
      noteIds.length ? supabase.from("teacher_note_reads").select("note_id").in("note_id", noteIds) : Promise.resolve({ data: [] }),
    ]);
    const authorMap = new Map((authorRows ?? []).map((row) => [row.id, row.display_name || row.email]));
    const readCounts = new Map<string, number>();
    (readRows ?? []).forEach((row) => readCounts.set(row.note_id, (readCounts.get(row.note_id) ?? 0) + 1));
    setNotes(noteBase.map((row) => ({ ...row, author_name: authorMap.get(row.author_user_id) ?? "Teacher", read_count: readCounts.get(row.id) ?? 0 })));

    setHandouts((handoutRows ?? []) as Handout[]);
    setPrintQueue((printRows ?? []) as PrintRequest[]);
    setHomework((homeworkRows ?? []) as Homework[]);
    setClassEvents((eventRows ?? []) as ClassEvent[]);
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
        <a className="active" href="#classes">Classes</a>
        <a href="#planning">Homework &amp; dates</a>
        <a href="#resources">Handouts</a>
        <a href="#lounge">Print queue</a>
        <a href="#news">Village news</a>
      </article>

      <div className="workspace-main">
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
                <span>{row.meeting_time || "Schedule to be announced"}{roleByClass[row.id] === "assistant" ? " · assisting" : ""}</span>
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
                      {child.first_name} {child.last_name}
                      <span>{noteCountLabel(notes.filter((n) => n.child_id === child.id && n.class_id === activeClassId).length)}</span>
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

        {activeClass && <PlanningSection
          klass={activeClass} isLead={isLead} userId={userId}
          homework={homework.filter((row) => row.class_id === activeClassId)}
          events={classEvents.filter((row) => row.class_id === activeClassId)}
          onSaved={reload}
        />}

        {activeClass && <ResourcesSection
          klass={activeClass} isLead={isLead} userId={userId}
          handouts={handouts.filter((row) => row.class_id === activeClassId)}
          onSaved={reload}
        />}

        {activeClass && <PrintSection
          klass={activeClass} isLead={isLead} userId={userId} queue={printQueue} onSaved={reload}
        />}

        <NewsSection classes={classes} />
      </div>
    </section>}
  </main>;
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
        <span className="note-meta">{note.author_name} · {note.visibility} · {formatDay(note.created_at)}{note.read_count > 0 ? ` · Read by ${note.read_count}` : ""}</span>
        <p>{note.body}</p>
        {note.author_user_id === userId && <button className="danger" onClick={() => onDelete(note.id)}>Delete</button>}
      </div>)}
      {!notes.length && <p className="portal-empty">No notes for {child.first_name} in this class yet.</p>}
    </div>
  </div>;
}

/** Homework and one-off class dates, both scoped to the selected class. */
function PlanningSection({ klass, isLead, userId, homework, events, onSaved }: {
  klass: ClassRow; isLead: boolean; userId: string;
  homework: Homework[]; events: ClassEvent[]; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const [eventTitle, setEventTitle] = useState("");
  const [eventAt, setEventAt] = useState("");
  const [eventLocation, setEventLocation] = useState("");

  async function addHomework(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim()) return;
    setBusy(true); setStatus("");
    // published_at is set on purpose -- an unpublished row stays invisible to
    // families, so "Save as draft" is a real state rather than a label.
    const { error } = await supabase.from("assignments").insert({
      class_id: klass.id, title: title.trim(), instructions: instructions.trim() || null,
      due_at: dueAt ? new Date(dueAt).toISOString() : null,
      published_at: new Date().toISOString(), created_by: userId,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setInstructions(""); setDueAt(""); setStatus("Homework published to families.");
    onSaved();
  }

  async function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !eventTitle.trim() || !eventAt) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.from("events").insert({
      class_id: klass.id, audience: "class", title: eventTitle.trim(),
      starts_at: new Date(eventAt).toISOString(), location: eventLocation.trim() || null,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setEventTitle(""); setEventAt(""); setEventLocation(""); setStatus("Date added to the class calendar.");
    onSaved();
  }

  async function removeHomework(id: string, name: string) {
    if (!confirm(`Remove "${name}"? Families will no longer see it.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("assignments").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    onSaved();
  }

  return <section id="planning">
    <p className="card-kicker">Homework &amp; dates</p>
    <h2>What&rsquo;s coming up in {klass.title}.</h2>
    <p className="portal-empty">Anything added here appears in the family portal for the children in this class.</p>

    {isLead ? <>
      <form onSubmit={addHomework} className="portal-form">
        <label><span className="field-caption">Homework</span>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Read chapters 4–5" disabled={busy} />
        </label>
        <label><span className="field-caption">Due</span>
          <input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} disabled={busy} />
        </label>
        <label><span className="field-caption">Instructions <i>optional</i></span>
          <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="What families should know" disabled={busy} />
        </label>
        <button disabled={busy}>{busy ? "Saving…" : "Add homework"}</button>
      </form>

      <form onSubmit={addEvent} className="portal-form">
        <label><span className="field-caption">Class date</span>
          <input required value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} placeholder="Bring a shoebox" disabled={busy} />
        </label>
        <label><span className="field-caption">When</span>
          <input required type="datetime-local" value={eventAt} onChange={(event) => setEventAt(event.target.value)} disabled={busy} />
        </label>
        <label><span className="field-caption">Where <i>optional</i></span>
          <input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} placeholder="Room 2" disabled={busy} />
        </label>
        <button disabled={busy}>{busy ? "Saving…" : "Add class date"}</button>
        <p className="admin-form-status" role="status">{status}</p>
      </form>
    </> : <p className="portal-empty">The lead teacher for {klass.title} sets homework and class dates.</p>}

    <div className="portal-stack">
      {homework.map((row) => <div key={row.id} className="teacher-class">
        <div>
          <b>{row.title}</b>
          <span>{row.due_at ? `Due ${formatDay(row.due_at)}` : "No due date"}{row.instructions ? ` · ${row.instructions}` : ""}</span>
        </div>
        {isLead && <button className="danger" onClick={() => removeHomework(row.id, row.title)}>Remove</button>}
      </div>)}
      {events.map((row) => <div key={row.id} className="teacher-class">
        <div>
          <b>{row.title}</b>
          <span>{formatDay(row.starts_at)}{row.location ? ` · ${row.location}` : ""}</span>
        </div>
        <span className="status-pill pending">Class date</span>
      </div>)}
      {!homework.length && !events.length && <p className="portal-empty">Nothing scheduled for {klass.title} yet.</p>}
    </div>
  </section>;
}

function ResourcesSection({ klass, isLead, userId, handouts, onSaved }: {
  klass: ClassRow; isLead: boolean; userId: string; handouts: Handout[]; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
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
      class_id: klass.id, kind: "handout", title: title.trim(), storage_path: uploaded.path, uploaded_by_user_id: userId,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setStatus("Handout posted.");
    onSaved();
  }

  async function download(path: string) {
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return <section id="resources">
    <p className="card-kicker">Handouts</p>
    <h2>Files for {klass.title}.</h2>

    {isLead ? <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">Title</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Week 4 spelling list" disabled={busy} />
      </label>
      <label className="file-drop"><span className="field-caption">File</span>
        <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <button disabled={busy}>{busy ? "Uploading…" : "Post handout"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form> : <p className="portal-empty">The lead teacher for {klass.title} posts handouts.</p>}

    <div className="portal-stack portal-stack-tight">
      {handouts.map((handout) => <div key={handout.id} className="teacher-class">
        <div><b>{handout.title}</b><span>{formatDay(handout.created_at)}</span></div>
        <button onClick={() => download(handout.storage_path)}>Open</button>
      </div>)}
      {!handouts.length && <p className="portal-empty">No handouts posted for {klass.title} yet.</p>}
    </div>
  </section>;
}

function PrintSection({ klass, isLead, userId, queue, onSaved }: {
  klass: ClassRow; isLead: boolean; userId: string; queue: PrintRequest[]; onSaved: () => void;
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

  return <section id="lounge">
    <p className="card-kicker">Print queue</p>
    <h2>Send something to be printed.</h2>

    {isLead ? <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">What is it?</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Friday worksheet packet" disabled={busy} />
      </label>
      <label><span className="field-caption">Copies needed</span>
        <input required type="number" min={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={busy} />
      </label>
      <label className="file-drop"><span className="field-caption">File to print</span>
        <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={forThisClass} onChange={(event) => setForThisClass(event.target.checked)} /> This printing is for {klass.title}
      </label>
      <button disabled={busy}>{busy ? "Sending…" : "Send to print queue"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form> : <p className="portal-empty">The lead teacher for {klass.title} sends print requests.</p>}

    <div className="print-queue">
      {queue.map((item) => <div className="print-item" key={item.id}>
        <div><b>{item.title}</b><span>{item.quantity} copies · requested {formatDay(item.created_at)}</span></div>
        <span className={`status-pill ${item.status}`}>{item.status}</span>
      </div>)}
      {!queue.length && <p className="portal-empty">Nothing in your print queue.</p>}
    </div>
  </section>;
}
