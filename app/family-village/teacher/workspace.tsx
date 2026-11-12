"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import PageSkeleton from "../page-skeleton";
import { uploadPrivateFile } from "../../../lib/storage";
import { queueFilePrintJob } from "../../../lib/print-jobs";
import { usePortalAccess } from "../../../lib/use-portal-access";
import MfaChallengeScreen from "../mfa-challenge";
import AppHeader from "../app-header";
import NewsSection from "./news-section";
import TeacherNav from "./teacher-nav";
import { ClassesSection } from "../classes/class-cards";

type ClassRow = { id: string; title: string };
type Assignment = { class_id: string; assignment_role: string; classes: ClassRow };
type PrintRequest = { id: string; title: string; quantity: number; status: string; storage_path: string; created_at: string; class_id: string | null };

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

function formatDay(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The Teacher home shows the class cards, team news and the print queue together;
 * news and print also have pages of their own. The class list and the class page
 * live in ../classes, because a parent opens the same class page.
 */
export type TeacherView = "home" | "news" | "print";

const TEACHER_HEADERS: Record<TeacherView, { title: string; subtitle: string }> = {
  home: { title: "Teacher\u2019s Lounge", subtitle: "Your classes, team news and printing in one place." },
  news: { title: "Teaching team news", subtitle: "Announcements for the teaching team." },
  print: { title: "Print queue", subtitle: "Handouts waiting for the office printer." },
};

export default function TeacherWorkspace({ view = "home" }: { view?: TeacherView }) {
  const show = (part: string) => view === "home" || view === part;
  const { state: access, userId, roles, recheck } = usePortalAccess("teacher");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  /** class_id -> 'lead' | 'assistant'. Only a lead sends a class's print requests. */
  const [roleByClass, setRoleByClass] = useState<Record<string, string>>({});
  const [printQueue, setPrintQueue] = useState<PrintRequest[]>([]);

  async function loadAll(uid: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data: assignments }, { data: printRows }] = await Promise.all([
      supabase.from("teacher_assignments").select("class_id,assignment_role,classes(id,title)").eq("user_id", uid),
      supabase.from("print_requests").select("id,title,quantity,status,storage_path,created_at,class_id").eq("requested_by_user_id", uid).is("cleared_at", null).order("created_at", { ascending: false }),
    ]);
    const rows = (assignments ?? []) as unknown as Assignment[];
    setClasses(rows.map((row) => row.classes).filter(Boolean));
    setRoleByClass(Object.fromEntries(rows.map((row) => [row.class_id, row.assignment_role])));
    setPrintQueue((printRows ?? []) as PrintRequest[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch once access resolves
  useEffect(() => { if (access === "ready" && userId) loadAll(userId); }, [access, userId]);

  // The header and bar stay put while the page fills in; only the content area is a placeholder.
  if (access === "loading") return <main className="workspace-preview"><AppHeader current="teacher" roles={roles} title={TEACHER_HEADERS[view].title} subtitle={TEACHER_HEADERS[view].subtitle} /><PageSkeleton /></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private teacher workspace</p><h1>Teacher access is required.</h1><a href="/family-village">Return to Family Village →</a></main>;

  const reload = () => loadAll(userId);

  return <main className="workspace-preview cls-page">
    <AppHeader current="teacher" roles={roles} title={TEACHER_HEADERS[view].title} subtitle={TEACHER_HEADERS[view].subtitle} />
    <section className="workspace-grid">
      <TeacherNav active={view} />

      <div className="workspace-main">
        {view === "home" && <section id="classes" className="cls-home-classes">
          <p className="card-kicker">My classes</p>
          <ClassesSection userId={userId} scope="teaching" />
        </section>}

        {show("news") && <NewsSection classes={classes} />}

        {show("print") && <PrintSection classes={classes} roleByClass={roleByClass} userId={userId} queue={printQueue} onSaved={reload} />}
      </div>
    </section>
  </main>;
}

/**
 * Not scoped to one class the way the roster/dates/files sections are --
 * a teacher's print queue naturally spans every class they teach, so this
 * gets its own class picker instead of losing "for which class" entirely
 * now that there's no single active class driving the page.
 */
function PrintSection({ classes, roleByClass, userId, queue, onSaved }: {
  classes: ClassRow[]; roleByClass: Record<string, string>; userId: string;
  queue: PrintRequest[]; onSaved: () => void;
}) {
  const ledClasses = classes.filter((row) => roleByClass[row.id] === "lead");
  const [title, setTitle] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [classId, setClassId] = useState(() => ledClasses[0]?.id ?? "");
  const [duplex, setDuplex] = useState(true);
  // Which of the two buttons (if either) is mid-submit -- they're two actions
  // on one shared set of fields, not two separate forms, so one shared
  // busy/status pair is enough; only one can run at a time in practice.
  const [busy, setBusy] = useState<false | "queue" | "office">(false);
  const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy("queue"); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "print-requests", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("print_requests").insert({
      class_id: classId || null, requested_by_user_id: userId,
      title: title.trim(), storage_path: uploaded.path, quantity,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setQuantity(1); setStatus("Sent to the print queue.");
    onSaved();
  }

  // Same fields, a different destination: print_jobs (the automated path,
  // eventually fulfilled by a Raspberry Pi script talking to the printer
  // directly) instead of print_requests (the manual queue above).
  async function sendToOfficePrinter() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) { setStatus("Add a title and choose a file first."); return; }
    setBusy("office"); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "print-requests", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const error = await queueFilePrintJob(supabase, {
      title: title.trim(), storagePath: uploaded.path, duplex, copies: quantity,
    });
    setBusy(false);
    if (error) { setStatus(error); return; }
    setStatus("Sent to the office printer.");
  }

  const classTitle = (id: string | null) => classes.find((row) => row.id === id)?.title;

  return <section id="lounge">
    <p className="card-kicker">Print queue</p>
    <h2>Send something to be printed.</h2>

    {ledClasses.length ? <form onSubmit={submit} className="portal-form">
      <label><span className="field-caption">What is it?</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Class worksheet packet" disabled={!!busy} />
      </label>
      <label><span className="field-caption">Copies needed</span>
        <input required type="number" min={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={!!busy} />
      </label>
      <label className="file-drop"><span className="field-caption">File to print</span>
        <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={!!busy} />
      </label>
      <label><span className="field-caption">Which class</span>
        <select value={classId} onChange={(event) => setClassId(event.target.value)} disabled={!!busy}>
          <option value="">Not class-specific</option>
          {ledClasses.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={duplex} onChange={(event) => setDuplex(event.target.checked)} disabled={!!busy} />
        <span>Print double-sided (office printer only)</span>
      </label>
      <div className="print-queue-actions">
        <button disabled={!!busy}>{busy === "queue" ? "Sending…" : "Send to print queue"}</button>
        <button type="button" className="ghost" disabled={!!busy || !file || !title.trim()} onClick={sendToOfficePrinter}>
          {busy === "office" ? "Sending…" : "Send to office printer"}
        </button>
      </div>
      <p className="admin-form-status" role="status">{status}</p>
    </form> : <p className="portal-empty">The lead teacher for a class sends its print requests.</p>}

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
