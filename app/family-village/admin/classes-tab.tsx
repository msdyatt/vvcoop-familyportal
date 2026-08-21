"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

type TeacherAssignment = { user_id: string; assignment_role: string; profiles: { display_name: string | null; email: string } | null };
type Enrollment = { child_id: string; status: string; children: { first_name: string; last_name: string | null } | null };
type ClassRow = {
  id: string; title: string; description: string | null; meeting_time: string | null; term: string | null; age_band: string | null; block_label: string | null; active: boolean;
  teacher_assignments: TeacherAssignment[]; enrollments: Enrollment[];
};
type TeacherOption = { user_id: string; profiles: { display_name: string | null; email: string } | null };
type ChildOption = { id: string; first_name: string; last_name: string | null; families: { display_name: string } | null };

export default function ClassesTab() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teacherOptions, setTeacherOptions] = useState<TeacherOption[]>([]);
  const [childOptions, setChildOptions] = useState<ChildOption[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data }, { data: teachers }, { data: children }] = await Promise.all([
      supabase.from("classes").select("id,title,description,meeting_time,term,age_band,block_label,active,teacher_assignments(user_id,assignment_role,profiles(display_name,email)),enrollments(child_id,status,children(first_name,last_name))").order("title"),
      supabase.from("user_roles").select("user_id,profiles(display_name,email)").eq("role", "teacher"),
      supabase.from("children").select("id,first_name,last_name,families(display_name)").eq("active", true).order("first_name"),
    ]);
    setClasses((data ?? []) as unknown as ClassRow[]);
    setTeacherOptions((teachers ?? []) as unknown as TeacherOption[]);
    setChildOptions((children ?? []) as unknown as ChildOption[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function addClass(event: React.FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("classes").insert({ title: newTitle.trim() });
    if (error) { setStatus(error.message); return; }
    setNewTitle(""); setStatus(`Added ${newTitle.trim()}.`);
    await load();
  }

  async function saveClass(row: ClassRow) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("classes").update({
      title: row.title, description: row.description, meeting_time: row.meeting_time, term: row.term, age_band: row.age_band, block_label: row.block_label, active: row.active,
    }).eq("id", row.id);
    if (error) { setStatus(error.message); return; }
    setStatus(`Saved ${row.title}.`);
    await load();
  }

  async function assignTeacher(classId: string, userId: string, role: string) {
    if (!userId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("teacher_assignments").insert({ class_id: classId, user_id: userId, assignment_role: role });
    if (error) { setStatus(error.message); return; }
    await load();
  }

  async function removeTeacher(classId: string, userId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("teacher_assignments").delete().eq("class_id", classId).eq("user_id", userId);
    if (error) { setStatus(error.message); return; }
    await load();
  }

  async function enrollChild(classId: string, childId: string) {
    if (!childId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("enrollments").insert({ class_id: classId, child_id: childId, status: "active" });
    if (error) { setStatus(error.message); return; }
    await load();
  }

  async function setEnrollmentStatus(classId: string, childId: string, nextStatus: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("enrollments").update({ status: nextStatus }).eq("class_id", classId).eq("child_id", childId);
    if (error) { setStatus(error.message); return; }
    await load();
  }

  if (loading) return <p>Loading classes…</p>;

  return <section className="classes-manage">
    <form className="add-class-form" onSubmit={addClass}>
      <label>New class title<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Friday Science" /></label>
      <button>Add class</button>
    </form>
    <p className="admin-form-status" role="status">{status}</p>
    <div className="classes-list">
      {classes.map((row) => <ClassCard key={row.id} row={row} teacherOptions={teacherOptions} childOptions={childOptions}
        onSave={saveClass} onAssignTeacher={assignTeacher} onRemoveTeacher={removeTeacher} onEnrollChild={enrollChild} onSetEnrollmentStatus={setEnrollmentStatus} />)}
    </div>
  </section>;
}

function ClassCard({ row, teacherOptions, childOptions, onSave, onAssignTeacher, onRemoveTeacher, onEnrollChild, onSetEnrollmentStatus }: {
  row: ClassRow; teacherOptions: TeacherOption[]; childOptions: ChildOption[];
  onSave: (row: ClassRow) => void;
  onAssignTeacher: (classId: string, userId: string, role: string) => void;
  onRemoveTeacher: (classId: string, userId: string) => void;
  onEnrollChild: (classId: string, childId: string) => void;
  onSetEnrollmentStatus: (classId: string, childId: string, status: string) => void;
}) {
  const [local, setLocal] = useState(row);
  const [teacherPick, setTeacherPick] = useState("");
  const [childPick, setChildPick] = useState("");

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLocal(row); }, [row]);

  const assignedIds = new Set(row.teacher_assignments.map((assignment) => assignment.user_id));
  const enrolledIds = new Set(row.enrollments.map((enrollment) => enrollment.child_id));

  return <article className="class-card">
    <div className="field-row">
      <label>Title<input value={local.title} onChange={(event) => setLocal({ ...local, title: event.target.value })} /></label>
      <label>Meeting time<input value={local.meeting_time ?? ""} onChange={(event) => setLocal({ ...local, meeting_time: event.target.value })} placeholder="Fridays 10:00" /></label>
      <label>Term<input value={local.term ?? ""} onChange={(event) => setLocal({ ...local, term: event.target.value })} /></label>
      <label>Age band<input value={local.age_band ?? ""} onChange={(event) => setLocal({ ...local, age_band: event.target.value })} placeholder="6-9" /></label>
      <label className="checkbox-field"><input type="checkbox" checked={local.active} onChange={(event) => setLocal({ ...local, active: event.target.checked })} /> Active</label>
      <button onClick={() => onSave(local)}>Save class</button>
    </div>
    <label className="description-field">Description<textarea value={local.description ?? ""} onChange={(event) => setLocal({ ...local, description: event.target.value })} /></label>

    <div className="class-subsection">
      <p className="card-kicker">Teachers</p>
      {row.teacher_assignments.map((assignment) => <div className="member-row" key={assignment.user_id}>
        <div><b>{assignment.profiles?.display_name || assignment.profiles?.email}</b><span>{assignment.assignment_role}</span></div>
        <div className="row-actions"><button className="danger" onClick={() => onRemoveTeacher(row.id, assignment.user_id)}>Remove</button></div>
      </div>)}
      <div className="add-row">
        <select value={teacherPick} onChange={(event) => setTeacherPick(event.target.value)}>
          <option value="">Add a teacher…</option>
          {teacherOptions.filter((option) => !assignedIds.has(option.user_id)).map((option) => <option key={option.user_id} value={option.user_id}>{option.profiles?.display_name || option.profiles?.email}</option>)}
        </select>
        <button onClick={() => { onAssignTeacher(row.id, teacherPick, "lead"); setTeacherPick(""); }}>Assign as lead</button>
        <button onClick={() => { onAssignTeacher(row.id, teacherPick, "assistant"); setTeacherPick(""); }}>Assign as assistant</button>
      </div>
    </div>

    <div className="class-subsection">
      <p className="card-kicker">Enrollment</p>
      {row.enrollments.map((enrollment) => <div className="member-row" key={enrollment.child_id}>
        <div><b>{enrollment.children?.first_name} {enrollment.children?.last_name}</b></div>
        <select value={enrollment.status} onChange={(event) => onSetEnrollmentStatus(row.id, enrollment.child_id, event.target.value)}>
          <option value="active">Active</option>
          <option value="waitlisted">Waitlisted</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
      </div>)}
      <div className="add-row">
        <select value={childPick} onChange={(event) => setChildPick(event.target.value)}>
          <option value="">Enroll a child…</option>
          {childOptions.filter((option) => !enrolledIds.has(option.id)).map((option) => <option key={option.id} value={option.id}>{option.first_name} {option.last_name} · {option.families?.display_name}</option>)}
        </select>
        <button onClick={() => { onEnrollChild(row.id, childPick); setChildPick(""); }}>Enroll</button>
      </div>
    </div>
  </article>;
}
