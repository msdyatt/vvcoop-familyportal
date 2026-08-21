"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";

type ClassInfo = { id: string; title: string; meeting_time: string | null; teachers: string[] };
type AssignmentInfo = { id: string; title: string; due_at: string | null; class_title: string };
type NoteInfo = { id: string; body: string; visibility: string; created_at: string };

type ChildRecord = { id: string; first_name: string; last_name: string | null };

export default function ChildDetail({ childId, onClose }: { childId: string; onClose: () => void }) {
  const [child, setChild] = useState<ChildRecord | null>(null);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [assignments, setAssignments] = useState<AssignmentInfo[]>([]);
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data: childRow }, { data: enrollments }, { data: noteRows }] = await Promise.all([
      supabase.from("children").select("id,first_name,last_name").eq("id", childId).single(),
      supabase.from("enrollments").select("class_id,status,classes(id,title,meeting_time,teacher_assignments(profiles(display_name,email)))").eq("child_id", childId).eq("status", "active"),
      supabase.from("teacher_notes").select("id,body,visibility,created_at").eq("child_id", childId).order("created_at", { ascending: false }),
    ]);
    setChild(childRow as ChildRecord | null);
    const rows = (enrollments ?? []) as unknown as { classes: { id: string; title: string; meeting_time: string | null; teacher_assignments: { profiles: { display_name: string | null; email: string } | null }[] } }[];
    const classInfos = rows.map((row) => ({
      id: row.classes.id,
      title: row.classes.title,
      meeting_time: row.classes.meeting_time,
      teachers: row.classes.teacher_assignments.map((assignment) => assignment.profiles?.display_name || assignment.profiles?.email || "").filter(Boolean),
    }));
    setClasses(classInfos);
    setNotes((noteRows ?? []) as NoteInfo[]);
    const classIds = classInfos.map((info) => info.id);
    if (classIds.length) {
      const { data: assignmentRows } = await supabase.from("assignments").select("id,title,due_at,class_id,classes(title)").in("class_id", classIds).order("due_at", { ascending: true }).limit(10);
      setAssignments(((assignmentRows ?? []) as unknown as { id: string; title: string; due_at: string | null; classes: { title: string } }[]).map((row) => ({ id: row.id, title: row.title, due_at: row.due_at, class_title: row.classes?.title ?? "" })));
    }
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- initial data fetch on mount
  useEffect(() => { load(); }, [childId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return <div className="child-detail-overlay" role="dialog" aria-modal="true">
    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- decorative backdrop; Escape and the close button provide keyboard access */}
    <div className="child-detail-backdrop" onClick={onClose} />
    <div className="child-detail-panel">
      <button className="child-detail-close" onClick={onClose} aria-label="Close">×</button>
      {loading ? <p>Loading…</p> : <>
        <p className="eyebrow">Student</p>
        <h2>{child?.first_name} {child?.last_name}</h2>

        <section>
          <p className="card-kicker">Classes</p>
          {classes.length ? <ul className="child-detail-list">{classes.map((row) => <li key={row.id}><b>{row.title}</b><span>{row.meeting_time || "Schedule to be announced"}{row.teachers.length ? ` · ${row.teachers.join(", ")}` : ""}</span></li>)}</ul> : <p className="portal-empty">Not enrolled in any classes yet.</p>}
        </section>

        <section>
          <p className="card-kicker">Assignments</p>
          {assignments.length ? <ul className="child-detail-list">{assignments.map((row) => <li key={row.id}><b>{row.title}</b><span>{row.class_title}{row.due_at ? ` · Due ${new Date(row.due_at).toLocaleDateString()}` : ""}</span></li>)}</ul> : <p className="portal-empty">No assignments right now.</p>}
        </section>

        <section>
          <p className="card-kicker">Teacher notes</p>
          {notes.length ? <ul className="child-detail-list">{notes.map((row) => <li key={row.id}><span>{new Date(row.created_at).toLocaleDateString()} · {row.visibility}</span><p>{row.body}</p></li>)}</ul> : <p className="portal-empty">No notes yet.</p>}
        </section>
      </>}
    </div>
  </div>;
}
