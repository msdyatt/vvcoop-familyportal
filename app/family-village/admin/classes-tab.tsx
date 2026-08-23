"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { SchoolYear } from "../../../lib/compliance";
import { ClassBlock, Room, formatBlock, formatBlockTime } from "../../../lib/schedule";
import { CollapsibleRecord, EditableSection, Field, GradePicker, formatGrades } from "./admin-ui";
import EnrollmentPeriods from "./enrollment-periods";

type TeacherAssignment = { user_id: string; assignment_role: string; profiles: { display_name: string | null; email: string } | null };
type Enrollment = { child_id: string; status: string; children: { first_name: string; last_name: string | null } | null };
type ClassRow = {
  id: string; title: string; description: string | null; term: string | null;
  grades: string[]; block_id: string | null; room_id: string | null;
  active: boolean; is_elective: boolean; school_year_id: string | null;
  teacher_assignments: TeacherAssignment[]; enrollments: Enrollment[];
};
type TeacherOption = { user_id: string; name: string; email: string };
type ChildOption = { id: string; first_name: string; last_name: string | null; families: { last_name: string | null; display_name: string } | null };

/** Full name where we have one. A roster of first names is useless the moment two Susies appear. */
function fullName(displayName: string | null, surname: string | null, email: string) {
  const first = (displayName ?? "").trim();
  const last = (surname ?? "").trim();
  if (first && last && !first.toLowerCase().endsWith(last.toLowerCase())) return `${first} ${last}`;
  return first || email;
}

export default function ClassesTab() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teacherOptions, setTeacherOptions] = useState<TeacherOption[]>([]);
  const [childOptions, setChildOptions] = useState<ChildOption[]>([]);
  const [years, setYears] = useState<SchoolYear[]>([]);
  const [blocks, setBlocks] = useState<ClassBlock[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [yearFilter, setYearFilter] = useState("current");
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data }, { data: teachers }, { data: children }, { data: yearRows }, { data: blockRows }, { data: roomRows }] = await Promise.all([
      supabase.from("classes").select("id,title,description,term,grades,block_id,room_id,active,is_elective,school_year_id,teacher_assignments(user_id,assignment_role,profiles(display_name,email)),enrollments(child_id,status,children(first_name,last_name))").order("title"),
      // The surname lives on the household, not the profile, so it is joined in
      // rather than showing a bare first name on every roster.
      supabase.from("user_roles").select("user_id,profiles(display_name,email)").eq("role", "teacher"),
      supabase.from("children").select("id,first_name,last_name,families(last_name,display_name)").eq("active", true).order("first_name"),
      supabase.from("school_years").select("id,label,starts_on,ends_on,is_current").order("label", { ascending: false }),
      supabase.from("class_blocks").select("id,label,starts_at,ends_at,sort_order,school_year_id").order("sort_order").order("starts_at"),
      supabase.from("rooms").select("id,name,note,active,sort_order").order("sort_order").order("name"),
    ]);

    const teacherRows = (teachers ?? []) as unknown as { user_id: string; profiles: { display_name: string | null; email: string } | null }[];
    const { data: memberRows } = teacherRows.length
      ? await supabase.from("family_members").select("user_id,families(last_name)").in("user_id", teacherRows.map((row) => row.user_id))
      : { data: [] };
    const surnames = new Map(((memberRows ?? []) as unknown as { user_id: string; families: { last_name: string | null } | null }[])
      .map((row) => [row.user_id, row.families?.last_name ?? null]));

    setClasses((data ?? []) as unknown as ClassRow[]);
    setTeacherOptions(teacherRows.map((row) => ({
      user_id: row.user_id,
      email: row.profiles?.email ?? "",
      name: fullName(row.profiles?.display_name ?? null, surnames.get(row.user_id) ?? null, row.profiles?.email ?? ""),
    })));
    setChildOptions((children ?? []) as unknown as ChildOption[]);
    setYears((yearRows ?? []) as SchoolYear[]);
    setBlocks((blockRows ?? []) as ClassBlock[]);
    setRooms((roomRows ?? []) as Room[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  const currentYear = years.find((year) => year.is_current) ?? null;

  const visible = useMemo(() => {
    if (yearFilter === "all") return classes;
    const wanted = yearFilter === "current" ? currentYear?.id ?? null : yearFilter;
    return classes.filter((row) => row.school_year_id === wanted);
  }, [classes, yearFilter, currentYear]);

  /**
   * Two active classes in one room at one time.
   *
   * Not a database constraint: a co-op legitimately shares a big room between a
   * combined class and a quiet table, and refusing the save would be wrong. A
   * warning on the card is enough -- the point is that nobody discovers it on a
   * Friday morning.
   */
  const clashes = useMemo(() => {
    const bySlot = new Map<string, ClassRow[]>();
    for (const row of visible) {
      if (!row.active || !row.block_id || !row.room_id) continue;
      const key = `${row.block_id}|${row.room_id}`;
      bySlot.set(key, [...(bySlot.get(key) ?? []), row]);
    }
    const found = new Map<string, string>();
    for (const group of bySlot.values()) {
      if (group.length < 2) continue;
      for (const row of group) {
        found.set(row.id, group.filter((other) => other.id !== row.id).map((other) => other.title).join(", "));
      }
    }
    return found;
  }, [visible]);

  async function addClass(event: FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const target = yearFilter === "all" || yearFilter === "current" ? currentYear?.id ?? null : yearFilter;
    const { error } = await supabase.from("classes").insert({ title: newTitle.trim(), school_year_id: target });
    if (error) { setStatus(error.message); return; }
    setStatus(`Added ${newTitle.trim()}.`); setNewTitle(""); setAdding(false);
    await load();
  }

  async function saveClass(row: ClassRow) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("classes").update({
      title: row.title, description: row.description, term: row.term,
      grades: row.grades, block_id: row.block_id, room_id: row.room_id, active: row.active,
      is_elective: row.is_elective, school_year_id: row.school_year_id,
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
    <div className="compliance-toolbar">
      <label><span className="field-caption">School year</span>
        <select value={yearFilter} onChange={(event) => setYearFilter(event.target.value)}>
          <option value="current">This year{currentYear ? ` · ${currentYear.label}` : ""}</option>
          {years.filter((year) => !year.is_current).map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
          <option value="all">Every year</option>
        </select>
      </label>
      {!adding
        ? <button className="make-current" onClick={() => setAdding(true)}>Add a class</button>
        : <form className="inline-edit" onSubmit={addClass}>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the field only exists after the user pressed Add, so focusing it follows their intent rather than hijacking it */}
              <input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Friday Science" />
            <button>Add</button>
            <button type="button" className="ghost" onClick={() => { setAdding(false); setNewTitle(""); }}>Cancel</button>
          </form>}
      <p className="compliance-summary">{visible.length} class{visible.length === 1 ? "" : "es"}</p>
    </div>

    <p className="admin-form-status" role="status">{status || "Open a class to see its roster and teachers. Nothing is editable until you choose to edit it."}</p>

    <SchoolYears years={years} onSaved={load} onStatus={setStatus} />

    <TimeBlocks blocks={blocks} years={years} currentYearId={currentYear?.id ?? null} onSaved={load} onStatus={setStatus} />

    <Rooms rooms={rooms} onSaved={load} onStatus={setStatus} />

    <EnrollmentPeriods years={years} currentYearId={currentYear?.id ?? null} onStatus={setStatus} />

    <div className="classes-list">
      {visible.map((row) => <ClassCard key={row.id} row={row} years={years} blocks={blocks} rooms={rooms}
        clash={clashes.get(row.id) ?? null}
        teacherOptions={teacherOptions} childOptions={childOptions}
        onSave={saveClass} onAssignTeacher={assignTeacher} onRemoveTeacher={removeTeacher}
        onEnrollChild={enrollChild} onSetEnrollmentStatus={setEnrollmentStatus} />)}
      {!visible.length && <p className="portal-empty">No classes for that year yet.</p>}
    </div>
  </section>;
}

/**
 * School years live here rather than in Compliance.
 *
 * A year is the thing classes are built inside, so the control belongs beside
 * them; Compliance merely borrows the current one.
 */
function SchoolYears({ years, onSaved, onStatus }: { years: SchoolYear[]; onSaved: () => void; onStatus: (message: string) => void }) {
  const [open, setOpen] = useState(false);

  async function makeCurrent(year: SchoolYear) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // Only one row may carry the flag -- a partial unique index enforces it --
    // so the outgoing year stands down first.
    const cleared = await supabase.from("school_years").update({ is_current: false }).eq("is_current", true);
    if (cleared.error) { onStatus(cleared.error.message); return; }
    const { error } = await supabase.from("school_years").update({ is_current: true }).eq("id", year.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`${year.label} is now the current school year.`);
    onSaved();
  }

  async function addYear(label: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const startYear = Number(label.slice(0, 4));
    const { error } = await supabase.from("school_years").insert({
      label, starts_on: `${startYear}-08-01`, ends_on: `${startYear + 1}-06-30`, is_current: false,
    });
    if (error) { onStatus(error.message); return; }
    onStatus(`Added ${label}. Switch to it when you are ready.`);
    onSaved();
  }

  const taken = new Set(years.map((year) => year.label));
  const start = new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const available = [0, 1, 2].map((offset) => `${start + offset}-${start + offset + 1}`).filter((label) => !taken.has(label));

  return <div className="record-section school-years">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>School years</b></span>
      <span className="record-meta">{years.find((year) => year.is_current)?.label ?? "none set"} is current</span>
    </button>
    {open && <div className="record-body">
      {years.map((year) => <div className="child-line" key={year.id}>
        <b>{year.label}</b>
        <span>{year.is_current ? "Current year" : "Not current"}</span>
        {!year.is_current && <button onClick={() => makeCurrent(year)}>Make current</button>}
      </div>)}
      {available.length > 0 && <div className="row-actions">
        {available.map((label) => <button key={label} className="ghost" onClick={() => addYear(label)}>Add {label}</button>)}
      </div>}
    </div>}
  </div>;
}

/**
 * The co-op day, defined once.
 *
 * A block is the unit a class is scheduled into, and its start and end times are
 * the only place a class time is stored -- change the block and every class in
 * it moves together, which is the behaviour anyone would expect and the old
 * free-text field could not give.
 *
 * Blocks are time-of-day only. If the co-op ever meets on more than one weekday,
 * a day-of-week column here is the change to make.
 */
function TimeBlocks({ blocks, years, currentYearId, onSaved, onStatus }: {
  blocks: ClassBlock[]; years: SchoolYear[]; currentYearId: string | null;
  onSaved: () => void; onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [startsAt, setStartsAt] = useState("09:00");
  const [endsAt, setEndsAt] = useState("10:00");
  const [busy, setBusy] = useState(false);

  async function addBlock(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !label.trim()) return;
    if (endsAt <= startsAt) { onStatus("A block has to end after it starts."); return; }
    setBusy(true);
    const { error } = await supabase.from("class_blocks").insert({
      label: label.trim(), starts_at: startsAt, ends_at: endsAt,
      school_year_id: currentYearId, sort_order: blocks.length,
    });
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    onStatus(`Added the ${label.trim()} block.`);
    setLabel("");
    onSaved();
  }

  async function removeBlock(block: ClassBlock) {
    if (!confirm(`Delete the "${block.label}" block? Classes in it will be left without a time.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // classes.block_id is ON DELETE SET NULL, so the classes survive and simply
    // report no time until they are given a new block.
    const { error } = await supabase.from("class_blocks").delete().eq("id", block.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`Deleted the ${block.label} block.`);
    onSaved();
  }

  return <div className="record-section school-years">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Time blocks</b></span>
      <span className="record-meta">{blocks.length ? `${blocks.length} block${blocks.length === 1 ? "" : "s"}` : "none set"}</span>
    </button>
    {open && <div className="record-body">
      <p className="field-note">
        A class takes its meeting time from the block it sits in. Two classes in the same block run at the same
        time, so a child can only be enrolled in one of them.
      </p>
      {blocks.map((block) => <div className="child-line" key={block.id}>
        <b>{block.label}</b>
        <span>{formatBlockTime(block)}{block.school_year_id ? ` · ${years.find((year) => year.id === block.school_year_id)?.label ?? ""}` : " · every year"}</span>
        <div className="row-actions">
          <button className="danger" onClick={() => removeBlock(block)}>Delete</button>
        </div>
      </div>)}
      {!blocks.length && <p className="portal-empty">No time blocks yet. Add one before scheduling classes.</p>}

      <form onSubmit={addBlock} className="portal-form">
        <label><span className="field-caption">Name</span>
          <input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="First period" disabled={busy} />
        </label>
        <label><span className="field-caption">Starts</span>
          <input required type="time" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} disabled={busy} />
        </label>
        <label><span className="field-caption">Ends</span>
          <input required type="time" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={busy} />
        </label>
        <div className="row-actions"><button disabled={busy}>{busy ? "Adding…" : "Add block"}</button></div>
      </form>
    </div>}
  </div>;
}

/**
 * The rooms the co-op meets in.
 *
 * A managed list rather than a text box on each class, so the same room is
 * always spelled the same way -- which is the only reason two classes booked
 * into one room at one time can be spotted at all.
 */
function Rooms({ rooms, onSaved, onStatus }: { rooms: Room[]; onSaved: () => void; onStatus: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function addRoom(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !name.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("rooms").insert({ name: name.trim(), sort_order: rooms.length });
    setBusy(false);
    if (error) { onStatus(error.message.includes("duplicate") ? `There is already a room called "${name.trim()}".` : error.message); return; }
    onStatus(`Added ${name.trim()}.`);
    setName("");
    onSaved();
  }

  async function toggleActive(room: Room) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // Retired rather than deleted: a past year's classes still point at it, and
    // deleting would quietly blank their room.
    const { error } = await supabase.from("rooms").update({ active: !room.active }).eq("id", room.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`${room.name} is ${room.active ? "retired" : "back in use"}.`);
    onSaved();
  }

  const live = rooms.filter((room) => room.active).length;

  return <div className="record-section school-years">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Rooms</b></span>
      <span className="record-meta">{live ? `${live} in use` : "none set"}</span>
    </button>
    {open && <div className="record-body">
      <p className="field-note">
        Retiring a room keeps it on the classes that already use it but takes it out of the picker.
      </p>
      {rooms.map((room) => <div className="child-line" key={room.id}>
        <b>{room.name}</b>
        <span>{room.active ? "In use" : "Retired"}</span>
        <div className="row-actions">
          <button onClick={() => toggleActive(room)}>{room.active ? "Retire" : "Bring back"}</button>
        </div>
      </div>)}
      {!rooms.length && <p className="portal-empty">No rooms yet.</p>}

      <form onSubmit={addRoom} className="portal-form">
        <label><span className="field-caption">Room name</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Fellowship Hall" disabled={busy} />
        </label>
        <div className="row-actions"><button disabled={busy}>{busy ? "Adding…" : "Add room"}</button></div>
      </form>
    </div>}
  </div>;
}

function ClassCard({ row, years, blocks, rooms, clash, teacherOptions, childOptions, onSave, onAssignTeacher, onRemoveTeacher, onEnrollChild, onSetEnrollmentStatus }: {
  row: ClassRow; years: SchoolYear[]; blocks: ClassBlock[]; rooms: Room[]; clash: string | null;
  teacherOptions: TeacherOption[]; childOptions: ChildOption[];
  onSave: (row: ClassRow) => void;
  onAssignTeacher: (classId: string, userId: string, role: string) => void;
  onRemoveTeacher: (classId: string, userId: string) => void;
  onEnrollChild: (classId: string, childId: string) => void;
  onSetEnrollmentStatus: (classId: string, childId: string, status: string) => void;
}) {
  const [local, setLocal] = useState(row);
  const [teacherPick, setTeacherPick] = useState("");
  const [teacherRole, setTeacherRole] = useState("lead");
  const [childPick, setChildPick] = useState("");

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLocal(row); }, [row]);

  const active = row.enrollments.filter((entry) => entry.status === "active");
  const block = blocks.find((option) => option.id === row.block_id) ?? null;
  const room = rooms.find((option) => option.id === row.room_id) ?? null;
  const teacherName = (assignment: TeacherAssignment) =>
    teacherOptions.find((option) => option.user_id === assignment.user_id)?.name
      ?? assignment.profiles?.display_name
      ?? assignment.profiles?.email
      ?? "Unnamed";

  return <CollapsibleRecord
    summary={<b>{row.title}</b>}
    meta={[
      block ? formatBlock(block) : "No time block",
      room?.name,
      formatGrades(row.grades),
      `${active.length} enrolled`,
      row.is_elective ? "elective" : null,
      row.active ? null : "inactive",
    ].filter(Boolean).join(" · ")}
    chips={<>
      {clash && <span className="status-pill outstanding">Room clash: {clash}</span>}
      {row.teacher_assignments.length
        ? <span className="record-teachers">{row.teacher_assignments.map(teacherName).join(", ")}</span>
        : <span className="status-pill outstanding">No teacher</span>}
    </>}
  >
    <EditableSection label="Class" onSave={() => onSave(local)} onCancel={() => setLocal(row)}>
      {(editing) => <div className="field-grid">
        <Field label="Title" value={row.title} editing={editing}>
          <input value={local.title} onChange={(event) => setLocal({ ...local, title: event.target.value })} />
        </Field>
        <Field label="Meets" value={formatBlock(block) || "No time block"} editing={editing}>
          <select value={local.block_id ?? ""} onChange={(event) => setLocal({ ...local, block_id: event.target.value || null })}>
            <option value="">No time block</option>
            {blocks.map((option) => <option key={option.id} value={option.id}>{formatBlock(option)}</option>)}
          </select>
        </Field>
        <Field label="Room" value={room?.name ?? "No room"} editing={editing}>
          <select value={local.room_id ?? ""} onChange={(event) => setLocal({ ...local, room_id: event.target.value || null })}>
            <option value="">No room</option>
            {rooms.filter((option) => option.active || option.id === local.room_id).map((option) =>
              <option key={option.id} value={option.id}>{option.name}{option.active ? "" : " (retired)"}</option>)}
          </select>
        </Field>
        <Field label="Grades" value={formatGrades(row.grades)} editing={editing}>
          <GradePicker selected={local.grades ?? []} onChange={(grades) => setLocal({ ...local, grades })} />
        </Field>
        <Field label="School year" value={years.find((year) => year.id === row.school_year_id)?.label ?? "Unassigned"} editing={editing}>
          <select value={local.school_year_id ?? ""} onChange={(event) => setLocal({ ...local, school_year_id: event.target.value || null })}>
            <option value="">Unassigned</option>
            {years.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
          </select>
        </Field>
        <Field label="Description" value={row.description} editing={editing}>
          <input value={local.description ?? ""} onChange={(event) => setLocal({ ...local, description: event.target.value })} />
        </Field>
        {editing && <>
          <label className="checkbox-field">
            <input type="checkbox" checked={local.is_elective} onChange={(event) => setLocal({ ...local, is_elective: event.target.checked })} />
            Elective — families choose this during an enrollment window
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={local.active} onChange={(event) => setLocal({ ...local, active: event.target.checked })} />
            Active
          </label>
        </>}
      </div>}
    </EditableSection>

    <div className="record-section">
      <p className="card-kicker">Teachers</p>
      {row.teacher_assignments.map((assignment) => <div className="child-line" key={assignment.user_id}>
        <b>{teacherName(assignment)}</b>
        <span>{assignment.assignment_role}</span>
        <button className="danger" onClick={() => onRemoveTeacher(row.id, assignment.user_id)}>Remove</button>
      </div>)}
      {!row.teacher_assignments.length && <p className="portal-empty">No teacher assigned yet.</p>}
      <div className="row-actions assign-row">
        <select value={teacherPick} onChange={(event) => setTeacherPick(event.target.value)}>
          <option value="">Add a teacher…</option>
          {teacherOptions.filter((option) => !row.teacher_assignments.some((a) => a.user_id === option.user_id))
            .map((option) => <option key={option.user_id} value={option.user_id}>{option.name}</option>)}
        </select>
        <select value={teacherRole} onChange={(event) => setTeacherRole(event.target.value)}>
          <option value="lead">Lead</option>
          <option value="assistant">Assistant</option>
        </select>
        <button disabled={!teacherPick} onClick={() => { onAssignTeacher(row.id, teacherPick, teacherRole); setTeacherPick(""); }}>Assign</button>
      </div>
    </div>

    <div className="record-section">
      <p className="card-kicker">Roster</p>
      {active.map((entry) => <div className="child-line" key={entry.child_id}>
        <b>{entry.children?.first_name} {entry.children?.last_name}</b>
        <span>enrolled</span>
        <button className="danger" onClick={() => onSetEnrollmentStatus(row.id, entry.child_id, "withdrawn")}>Withdraw</button>
      </div>)}
      {!active.length && <p className="portal-empty">Nobody is enrolled in this class yet.</p>}
      <div className="row-actions assign-row">
        <select value={childPick} onChange={(event) => setChildPick(event.target.value)}>
          <option value="">Enroll a child…</option>
          {childOptions.filter((child) => !active.some((entry) => entry.child_id === child.id))
            .map((child) => <option key={child.id} value={child.id}>
              {child.first_name} {child.last_name ?? child.families?.last_name ?? ""}
            </option>)}
        </select>
        <button disabled={!childPick} onClick={() => { onEnrollChild(row.id, childPick); setChildPick(""); }}>Enroll</button>
      </div>
    </div>
  </CollapsibleRecord>;
}
