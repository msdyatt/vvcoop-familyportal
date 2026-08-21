"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../../lib/storage";
import PortalNav from "../portal-nav";

type AccessState = "loading" | "denied" | "ready";
type ClassRow = { id: string; title: string; description: string | null; meeting_time: string | null };
type RosterChild = { id: string; first_name: string; last_name: string | null; class_id: string };
type Note = { id: string; body: string; visibility: string; created_at: string; child_id: string; class_id: string };
type Handout = { id: string; title: string; storage_path: string; class_id: string | null; created_at: string };
type PrintRequest = { id: string; title: string; quantity: number; status: string; storage_path: string; created_at: string };

export default function TeacherWorkspace() {
  const [access, setAccess] = useState<AccessState>(() => getSupabaseBrowserClient() ? "loading" : "denied");
  const [userId, setUserId] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [roster, setRoster] = useState<RosterChild[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [handouts, setHandouts] = useState<Handout[]>([]);
  const [printQueue, setPrintQueue] = useState<PrintRequest[]>([]);

  async function loadAll(uid: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: assignments } = await supabase.from("teacher_assignments").select("class_id,classes(id,title,description,meeting_time)").eq("user_id", uid);
    const myClasses = ((assignments ?? []) as unknown as { classes: ClassRow }[]).map((row) => row.classes).filter(Boolean);
    setClasses(myClasses);
    const classIds = myClasses.map((row) => row.id);
    if (!classIds.length) return;
    const [{ data: enrollments }, { data: noteRows }, { data: handoutRows }, { data: printRows }] = await Promise.all([
      supabase.from("enrollments").select("child_id,class_id,children(id,first_name,last_name)").in("class_id", classIds).eq("status", "active"),
      supabase.from("teacher_notes").select("id,body,visibility,created_at,child_id,class_id").in("class_id", classIds).order("created_at", { ascending: false }).limit(30),
      supabase.from("documents").select("id,title,storage_path,class_id,created_at").in("class_id", classIds).order("created_at", { ascending: false }),
      supabase.from("print_requests").select("id,title,quantity,status,storage_path,created_at").eq("requested_by_user_id", uid).order("created_at", { ascending: false }),
    ]);
    setRoster(((enrollments ?? []) as unknown as { children: { id: string; first_name: string; last_name: string | null } ; class_id: string }[]).map((row) => ({ ...row.children, class_id: row.class_id })));
    setNotes((noteRows ?? []) as Note[]);
    setHandouts((handoutRows ?? []) as Handout[]);
    setPrintQueue((printRows ?? []) as PrintRequest[]);
  }

  useEffect(() => {
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setAccess("denied"); return; }
      const [{ data: profile }, { data: teacherRole }, { data: allRoles }] = await Promise.all([
        supabase.from("profiles").select("status").eq("id", data.user.id).single(),
        supabase.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "teacher").maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", data.user.id),
      ]);
      if (profile?.status !== "active" || !teacherRole) { setAccess("denied"); return; }
      setUserId(data.user.id);
      setRoles((allRoles ?? []).map((row) => row.role));
      setAccess("ready");
      await loadAll(data.user.id);
    });
  }, []);

  if (access === "loading") return <main className="portal-state"><p className="eyebrow">Teacher workspace</p><h1>Gathering your classes…</h1></main>;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private teacher workspace</p><h1>Teacher access is required.</h1><a href="/family-village">Return to Family Village →</a></main>;

  return <main className="workspace-preview">
    <header><div><p className="eyebrow">Teacher workspace</p><h1>Teach with the whole<br /><em>week in view.</em></h1></div><PortalNav current="teacher" roles={roles} /></header>
    <div className="preview-banner"><b>Only your assigned classes are shown.</b> Families and students outside your roster stay private.</div>
    {!classes.length && <p style={{ marginTop: 24 }}>No classes are assigned to you yet. A Village administrator can assign you to a class.</p>}
    {classes.length > 0 && <section className="workspace-grid">
      <article className="workspace-nav"><a className="active" href="#classes">Classes</a><a href="#notes">Student notes</a><a href="#resources">Resources</a><a href="#lounge">Teachers’ Lounge</a></article>
      <div className="workspace-main">
        <section id="classes"><p className="card-kicker">My classes</p><h2>Your classroom, organized.</h2>
          {classes.map((row) => <div className="teacher-class" key={row.id}><div><b>{row.title}</b><span>{row.meeting_time || "Schedule to be announced"}</span></div></div>)}
        </section>
        <NotesSection classes={classes} roster={roster} notes={notes} userId={userId} onSaved={() => loadAll(userId)} />
        <ResourcesSection classes={classes} handouts={handouts} userId={userId} onSaved={() => loadAll(userId)} />
        <LoungeSection classes={classes} queue={printQueue} userId={userId} onSaved={() => loadAll(userId)} />
      </div>
    </section>}
  </main>;
}

function NotesSection({ classes, roster, notes, userId, onSaved }: { classes: ClassRow[]; roster: RosterChild[]; notes: Note[]; userId: string; onSaved: () => void }) {
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [childId, setChildId] = useState("");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState("family");
  const [busy, setBusy] = useState(false);
  const childrenInClass = roster.filter((child) => child.class_id === classId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !childId || !body.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("teacher_notes").insert({ child_id: childId, class_id: classId, author_user_id: userId, body: body.trim(), visibility });
    setBusy(false);
    if (!error) { setBody(""); onSaved(); }
  }

  return <section id="notes"><p className="card-kicker">Student notes</p><h2>Thoughtful, controlled communication.</h2>
    <div className="note-rules"><span>Family visible</span><span>Teaching team only</span><span>Administrators only</span></div>
    <form onSubmit={submit} className="editor-placeholder">
      <label>Class<select value={classId} onChange={(event) => { setClassId(event.target.value); setChildId(""); }}>{classes.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label>Student<select required value={childId} onChange={(event) => setChildId(event.target.value)}><option value="">Choose a student</option>{childrenInClass.map((child) => <option key={child.id} value={child.id}>{child.first_name} {child.last_name}</option>)}</select></label>
      <label>Note<textarea required value={body} onChange={(event) => setBody(event.target.value)} placeholder="Progress, behavior, or a note home" disabled={busy} /></label>
      <label>Visible to<select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="family">Family</option><option value="teachers">Teaching team only</option><option value="admins">Administrators only</option></select></label>
      <button disabled={busy}>{busy ? "Saving…" : "Save note"}</button>
    </form>
    <div style={{ marginTop: 20, display: "grid", gap: 10 }}>
      {notes.filter((note) => note.class_id === classId).map((note) => <div key={note.id} style={{ padding: 12, background: "var(--mist)", fontSize: 13 }}>
        <b>{roster.find((child) => child.id === note.child_id)?.first_name}</b> · {note.visibility} · {new Date(note.created_at).toLocaleDateString()}<br />{note.body}
      </div>)}
    </div>
  </section>;
}

function ResourcesSection({ classes, handouts, userId, onSaved }: { classes: ClassRow[]; handouts: Handout[]; userId: string; onSaved: () => void }) {
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [title, setTitle] = useState(""); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "handouts", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("documents").insert({ class_id: classId, kind: "handout", title: title.trim(), storage_path: uploaded.path, uploaded_by_user_id: userId });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setStatus("Handout posted.");
    onSaved();
  }

  async function download(path: string) {
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path);
    if (url) window.open(url, "_blank");
  }

  return <section id="resources"><p className="card-kicker">Resources</p><h2>Handouts families and students can find.</h2>
    <form onSubmit={submit} className="editor-placeholder">
      <label>Class<select value={classId} onChange={(event) => setClassId(event.target.value)}>{classes.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label>Title<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Week 4 spelling list" disabled={busy} /></label>
      <label className="file-drop">File<input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
      <button disabled={busy}>{busy ? "Uploading…" : "Post handout"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
    <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
      {handouts.map((handout) => <div key={handout.id} className="teacher-class"><div><b>{handout.title}</b><span>{new Date(handout.created_at).toLocaleDateString()}</span></div><button onClick={() => download(handout.storage_path)}>Open</button></div>)}
      {!handouts.length && <p>No handouts posted yet.</p>}
    </div>
  </section>;
}

function LoungeSection({ classes, queue, userId, onSaved }: { classes: ClassRow[]; queue: PrintRequest[]; userId: string; onSaved: () => void }) {
  const [classId, setClassId] = useState("");
  const [title, setTitle] = useState(""); const [quantity, setQuantity] = useState(1); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "print-requests", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("print_requests").insert({ class_id: classId || null, requested_by_user_id: userId, title: title.trim(), storage_path: uploaded.path, quantity });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setQuantity(1); setStatus("Sent to the print queue.");
    onSaved();
  }

  return <section id="lounge"><p className="card-kicker">Teachers’ Lounge</p><h2>Send something to be printed.</h2>
    <form onSubmit={submit} className="editor-placeholder">
      <label>Class <span>optional</span><select value={classId} onChange={(event) => setClassId(event.target.value)}><option value="">Not class-specific</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label>What is it?<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Friday worksheet packet" disabled={busy} /></label>
      <label>Copies needed<input required type="number" min={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={busy} /></label>
      <label className="file-drop">File to print<input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
      <button disabled={busy}>{busy ? "Sending…" : "Send to print queue"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
    <div className="print-queue">
      {queue.map((item) => <div className="print-item" key={item.id}><div><b>{item.title}</b><span>{item.quantity} copies · requested {new Date(item.created_at).toLocaleDateString()}</span></div><span className={`status-pill ${item.status}`}>{item.status}</span></div>)}
      {!queue.length && <p>Nothing in your print queue.</p>}
    </div>
  </section>;
}
