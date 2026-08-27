"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../../lib/storage";
import SubscribeLink from "../subscribe-link";
import { SchoolYear, formatDate } from "../../../lib/compliance";
import { ClassBlock, Room, WEEKDAYS, formatBlock, formatBlockTime, formatWeekday } from "../../../lib/schedule";
import { printElement } from "../../../lib/dom";
import { CollapsibleRecord, ConfirmDeleteModal, EditableSection, Field, GRADES, GradePicker, formatGrades } from "./admin-ui";
import EnrollmentPeriods from "./enrollment-periods";
import DetailModal from "../detail-modal";

type TeacherAssignment = { user_id: string; assignment_role: string; profiles: { display_name: string | null; email: string } | null };
type Enrollment = { child_id: string; status: string; children: { first_name: string; last_name: string | null; age_band: string | null; families: { last_name: string | null; display_name: string } | null } | null };
type AcademicTerm = { id: string; school_year_id: string; label: string; starts_on: string; ends_on: string; sort_order: number };
type ClassTerm = { class_id: string; term_id: string };
type ClassRow = {
  id: string; title: string; description: string | null; term: string | null;
  grades: string[]; block_id: string | null; room_id: string | null;
  active: boolean; is_elective: boolean; school_year_id: string | null; calendar_token: string;
  teacher_assignments: TeacherAssignment[]; enrollments: Enrollment[]; term_ids: string[];
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

export default function ClassesTab({ actorUserId }: { actorUserId: string }) {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teacherOptions, setTeacherOptions] = useState<TeacherOption[]>([]);
  const [childOptions, setChildOptions] = useState<ChildOption[]>([]);
  const [years, setYears] = useState<SchoolYear[]>([]);
  const [blocks, setBlocks] = useState<ClassBlock[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [yearFilter, setYearFilter] = useState("current");
  const [classFilter, setClassFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [masterRosterOpen, setMasterRosterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data }, { data: teachers }, { data: children }, { data: yearRows }, { data: blockRows }, { data: roomRows }, { data: termRows }, { data: classTermRows }] = await Promise.all([
      supabase.from("classes").select("id,title,description,term,grades,block_id,room_id,active,is_elective,school_year_id,calendar_token,teacher_assignments(user_id,assignment_role,profiles(display_name,email)),enrollments(child_id,status,children(first_name,last_name,age_band,families(last_name,display_name)))").order("title"),
      // The surname lives on the household, not the profile, so it is joined in
      // rather than showing a bare first name on every roster.
      supabase.from("user_roles").select("user_id,profiles(display_name,email)").eq("role", "teacher"),
      supabase.from("children").select("id,first_name,last_name,families(last_name,display_name)").eq("active", true).order("first_name"),
      supabase.from("school_years").select("id,label,starts_on,ends_on,is_current").order("label", { ascending: false }),
      supabase.from("class_blocks").select("id,label,starts_at,ends_at,sort_order,school_year_id,day_of_week").order("day_of_week").order("sort_order").order("starts_at"),
      supabase.from("rooms").select("id,name,note,active,sort_order").order("sort_order").order("name"),
      supabase.from("academic_terms").select("id,school_year_id,label,starts_on,ends_on,sort_order").order("sort_order").order("starts_on"),
      supabase.from("class_terms").select("class_id,term_id"),
    ]);

    const teacherRows = (teachers ?? []) as unknown as { user_id: string; profiles: { display_name: string | null; email: string } | null }[];
    const { data: memberRows } = teacherRows.length
      ? await supabase.from("family_members").select("user_id,families(last_name)").in("user_id", teacherRows.map((row) => row.user_id))
      : { data: [] };
    const surnames = new Map(((memberRows ?? []) as unknown as { user_id: string; families: { last_name: string | null } | null }[])
      .map((row) => [row.user_id, row.families?.last_name ?? null]));

    const termLinks = (classTermRows ?? []) as ClassTerm[];
    setClasses(((data ?? []) as unknown as Omit<ClassRow, "term_ids">[]).map((row) => ({
      ...row,
      term_ids: termLinks.filter((link) => link.class_id === row.id).map((link) => link.term_id),
    })));
    setTeacherOptions(teacherRows.map((row) => ({
      user_id: row.user_id,
      email: row.profiles?.email ?? "",
      name: fullName(row.profiles?.display_name ?? null, surnames.get(row.user_id) ?? null, row.profiles?.email ?? ""),
    })));
    setChildOptions((children ?? []) as unknown as ChildOption[]);
    setYears((yearRows ?? []) as SchoolYear[]);
    setBlocks((blockRows ?? []) as ClassBlock[]);
    setRooms((roomRows ?? []) as Room[]);
    setTerms((termRows ?? []) as AcademicTerm[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  const currentYear = years.find((year) => year.is_current) ?? null;
  const targetYearId = yearFilter === "all" ? null : yearFilter === "current" ? currentYear?.id ?? null : yearFilter;
  const targetYear = years.find((year) => year.id === targetYearId) ?? null;

  const yearClasses = useMemo(() => {
    if (yearFilter === "all") return classes;
    const wanted = yearFilter === "current" ? currentYear?.id ?? null : yearFilter;
    return classes.filter((row) => row.school_year_id === wanted);
  }, [classes, yearFilter, currentYear]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return yearClasses.filter((row) => {
      if (query && !`${row.title} ${row.description ?? ""}`.toLowerCase().includes(query)) return false;
      const activeEnrollmentCount = row.enrollments.filter((entry) => entry.status === "active").length;
      if (classFilter === "needs-teachers" && row.teacher_assignments.length >= 2) return false;
      if (classFilter === "empty" && activeEnrollmentCount > 0) return false;
      if (classFilter === "elective" && !row.is_elective) return false;
      if (classFilter === "standard" && row.is_elective) return false;
      return true;
    });
  }, [yearClasses, classFilter, search]);

  /**
   * Two active classes in one room at one time.
   *
   * Not a database constraint: a co-op legitimately shares a big room between a
   * combined class and a quiet table, and refusing the save would be wrong. A
   * warning on the card is enough -- the point is that nobody discovers it on a
   * a co-op morning.
   */
  const clashes = useMemo(() => {
    // Computed from every class in the year, not `visible` -- a search term
    // or the class/status filter narrowing what's on screen must not also
    // narrow which classes get checked against each other, or the clash pill
    // silently vanishes the moment only one of the two clashing classes
    // matches the filter, exactly the co-op-morning surprise this exists to
    // prevent.
    const bySlot = new Map<string, ClassRow[]>();
    for (const row of yearClasses) {
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
  }, [yearClasses]);

  const classCounts = useMemo(() => ({
    all: yearClasses.length,
    "needs-teachers": yearClasses.filter((row) => row.teacher_assignments.length < 2).length,
    empty: yearClasses.filter((row) => !row.enrollments.some((entry) => entry.status === "active")).length,
    elective: yearClasses.filter((row) => row.is_elective).length,
    standard: yearClasses.filter((row) => !row.is_elective).length,
  }), [yearClasses]);

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
    const wanted = row.term_ids;
    // The class_terms read doesn't depend on the classes update completing --
    // they touch different tables -- so there's no reason to pay for two
    // round trips back to back before even starting the term diff below.
    const [{ error }, { data: existingRows, error: existingError }] = await Promise.all([
      supabase.from("classes").update({
        title: row.title, description: row.description, term: row.term,
        grades: row.grades, block_id: row.block_id, room_id: row.room_id, active: row.active,
        is_elective: row.is_elective, school_year_id: row.school_year_id,
      }).eq("id", row.id),
      supabase.from("class_terms").select("term_id").eq("class_id", row.id),
    ]);
    if (error) { setStatus(error.message); return; }
    if (existingError) { setStatus(`The class details saved, but its terms could not be checked: ${existingError.message}`); return; }

    const existing = new Set((existingRows ?? []).map((item) => item.term_id));
    const add = wanted.filter((termId) => !existing.has(termId));
    const remove = [...existing].filter((termId) => !wanted.includes(termId));
    // Disjoint term-id sets -- adding the newly-checked terms and removing
    // the newly-unchecked ones can't conflict with each other, so there's no
    // reason to wait for one before starting the other.
    const [added, removed] = await Promise.all([
      add.length ? supabase.from("class_terms").insert(add.map((termId) => ({ class_id: row.id, term_id: termId }))) : Promise.resolve({ error: null }),
      remove.length ? supabase.from("class_terms").delete().eq("class_id", row.id).in("term_id", remove) : Promise.resolve({ error: null }),
    ]);
    if (added.error || removed.error) {
      setStatus(`The class details saved, but its terms did not fully update: ${added.error?.message ?? removed.error?.message}`);
      return;
    }
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

  return <>
  <section className="classes-manage">
    <div className="compliance-toolbar">
      <label><span className="field-caption">School year</span>
        <select value={yearFilter} onChange={(event) => setYearFilter(event.target.value)}>
          <option value="current">This year{currentYear ? ` · ${currentYear.label}` : ""}</option>
          {years.filter((year) => !year.is_current).map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
          <option value="all">Every year</option>
        </select>
      </label>
      {targetYear && <button className="ghost" onClick={() => setMasterRosterOpen(true)}>Print master roster</button>}
      {!adding
        ? <button className="make-current" onClick={() => setAdding(true)}>Add a class</button>
        : <form className="inline-edit" onSubmit={addClass}>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the field only exists after the user pressed Add, so focusing it follows their intent rather than hijacking it */}
              <input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Foundations Science" />
            <button>Add</button>
            <button type="button" className="ghost" onClick={() => { setAdding(false); setNewTitle(""); }}>Cancel</button>
          </form>}
      <p className="compliance-summary">{visible.length} class{visible.length === 1 ? "" : "es"}</p>
    </div>

    <p className="admin-form-status" role="status">{status || "Open a class to see its roster and teachers. Nothing is editable until you choose to edit it."}</p>

    <div className="summary-filter-cards" aria-label="Class summaries">
      {([
        ["all", "All classes"],
        ["needs-teachers", "Need two teachers"],
        ["empty", "No students"],
        ["elective", "Electives"],
        ["standard", "Standard"],
      ] as const).map(([key, label]) => <button key={key} className={classFilter === key ? "active" : ""} onClick={() => setClassFilter(key)}>
        <b>{classCounts[key]}</b><span>{label}</span>
      </button>)}
    </div>

    <div className="list-filters">
      <label><span className="field-caption">Find a class</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title or description" /></label>
      <label><span className="field-caption">Show</span>
        <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
          <option value="all">All classes</option>
          <option value="needs-teachers">Fewer than two teachers</option>
          <option value="empty">No students enrolled</option>
          <option value="elective">Electives</option>
          <option value="standard">Standard classes</option>
        </select>
      </label>
    </div>

    <div className="classes-list">
      {visible.map((row) => <ClassCard key={row.id} row={row} years={years} blocks={blocks} rooms={rooms}
        terms={terms}
        clash={clashes.get(row.id) ?? null}
        teacherOptions={teacherOptions} childOptions={childOptions}
        actorUserId={actorUserId}
        onSave={saveClass} onAssignTeacher={assignTeacher} onRemoveTeacher={removeTeacher}
        onEnrollChild={enrollChild} onSetEnrollmentStatus={setEnrollmentStatus} />)}
      {!visible.length && <p className="portal-empty">No classes for that year yet.</p>}
    </div>

    <details className="schedule-settings">
      <summary><span>Schedule &amp; enrollment settings</span><small>School years, terms, meeting times, rooms, and enrollment windows</small></summary>
      <div className="schedule-settings-body">
        <SchoolYears years={years} onSaved={load} onStatus={setStatus} />
        <AcademicTerms terms={terms} years={years} currentYearId={currentYear?.id ?? null} onSaved={load} onStatus={setStatus} />
        <TimeBlocks blocks={blocks} years={years} currentYearId={currentYear?.id ?? null} onSaved={load} onStatus={setStatus} />
        <Rooms rooms={rooms} onSaved={load} onStatus={setStatus} />
        <EnrollmentPeriods years={years} currentYearId={currentYear?.id ?? null} onStatus={setStatus} />
      </div>
    </details>
  </section>
  {masterRosterOpen && targetYear && <DetailModal title={`${targetYear.label} master roster`} onClose={() => setMasterRosterOpen(false)}>
    <MasterRoster classes={yearClasses.filter((row) => row.active)} blocks={blocks} rooms={rooms} terms={terms.filter((term) => term.school_year_id === targetYear.id)} year={targetYear} />
  </DetailModal>}
  </>;
}

/**
 * School years live here rather than in Compliance.
 *
 * A year is the thing classes are built inside, so the control belongs beside
 * them; Compliance merely borrows the current one.
 */
function SchoolYears({ years, onSaved, onStatus }: { years: SchoolYear[]; onSaved: () => void; onStatus: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [deletingYear, setDeletingYear] = useState<SchoolYear | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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

  /** Terms, meeting blocks, and enrollment windows for the year go with it; its classes are kept but become unassigned to any year. */
  async function removeYear(year: SchoolYear) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setDeleteBusy(true);
    const { error } = await supabase.from("school_years").delete().eq("id", year.id);
    setDeleteBusy(false);
    if (error) { onStatus(error.message); return; }
    setDeletingYear(null);
    onStatus(`Deleted ${year.label}.`);
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
        {!year.is_current && <div className="row-actions">
          <button onClick={() => makeCurrent(year)}>Make current</button>
          <button className="danger" onClick={() => setDeletingYear(year)}>Delete</button>
        </div>}
      </div>)}
      {available.length > 0 && <div className="row-actions">
        {available.map((label) => <button key={label} className="ghost" onClick={() => addYear(label)}>Add {label}</button>)}
      </div>}
    </div>}

    {deletingYear && <ConfirmDeleteModal
      title={`Delete ${deletingYear.label}`}
      description="This removes the year's terms, meeting blocks, and enrollment windows, and every compliance requirement tied to it -- signed waivers and payment records included. Its classes are kept but become unassigned to any year. This cannot be undone."
      busy={deleteBusy}
      onConfirm={() => removeYear(deletingYear)}
      onCancel={() => setDeletingYear(null)}
    />}
  </div>;
}

/** Date-bounded quarters, semesters, or custom pieces of a school year. */
function AcademicTerms({ terms, years, currentYearId, onSaved, onStatus }: {
  terms: AcademicTerm[]; years: SchoolYear[]; currentYearId: string | null;
  onSaved: () => void; onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [busy, setBusy] = useState(false);

  async function addTerm(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !currentYearId || !label.trim()) return;
    if (endsOn < startsOn) { onStatus("A term has to end on or after it starts."); return; }
    setBusy(true);
    const { error } = await supabase.from("academic_terms").insert({
      school_year_id: currentYearId,
      label: label.trim(),
      starts_on: startsOn,
      ends_on: endsOn,
      sort_order: terms.filter((term) => term.school_year_id === currentYearId).length,
    });
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    onStatus(`Added ${label.trim()}.`);
    setLabel(""); setStartsOn(""); setEndsOn("");
    onSaved();
  }

  async function saveTerm(term: AcademicTerm) {
    if (term.ends_on < term.starts_on) { onStatus("A term has to end on or after it starts."); return; }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("academic_terms").update({
      label: term.label.trim(), starts_on: term.starts_on, ends_on: term.ends_on,
    }).eq("id", term.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`Saved ${term.label}.`);
    onSaved();
  }

  async function removeTerm(term: AcademicTerm) {
    if (!confirm(`Delete "${term.label}"? Classes will no longer be assigned to it.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("academic_terms").delete().eq("id", term.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`Deleted ${term.label}.`);
    onSaved();
  }

  return <div className="record-section school-years">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>School-year terms</b></span>
      <span className="record-meta">{terms.length ? `${terms.length} term${terms.length === 1 ? "" : "s"}` : "none set"}</span>
    </button>
    {open && <div className="record-body">
      <p className="field-note">Create semesters, quarters, or custom date ranges. A class may belong to one or several terms.</p>
      {terms.map((term) => <AcademicTermRow key={term.id} term={term} yearLabel={years.find((year) => year.id === term.school_year_id)?.label ?? "School year"} onSave={saveTerm} onDelete={removeTerm} />)}
      {!terms.length && <p className="portal-empty">No terms yet.</p>}
      <form onSubmit={addTerm} className="portal-form">
        <label><span className="field-caption">Name</span><input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Fall semester" disabled={busy || !currentYearId} /></label>
        <label><span className="field-caption">Starts</span><input required type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} disabled={busy || !currentYearId} /></label>
        <label><span className="field-caption">Ends</span><input required type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} disabled={busy || !currentYearId} /></label>
        <div className="row-actions"><button disabled={busy || !currentYearId}>{busy ? "Adding…" : "Add term"}</button></div>
        {!currentYearId && <p className="field-note">Choose a current school year first.</p>}
      </form>
    </div>}
  </div>;
}

function AcademicTermRow({ term, yearLabel, onSave, onDelete }: {
  term: AcademicTerm; yearLabel: string;
  onSave: (term: AcademicTerm) => void; onDelete: (term: AcademicTerm) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(term);
  // Local only ever copies the prop when editing starts or is cancelled, not
  // on every render of the parent's data -- a useEffect keyed on `term` fired
  // whenever any OTHER term/block/room in the same panel saved (the parent's
  // load() refetches all three lists as new object references), silently
  // wiping an in-progress, unsaved edit in this row back to its last-saved
  // text.
  function startEditing() { setLocal(term); setEditing(true); }
  return <div className="child-line term-row">
    {editing ? <>
      <input aria-label="Term name" value={local.label} onChange={(event) => setLocal({ ...local, label: event.target.value })} />
      <input aria-label="Term start" type="date" value={local.starts_on} onChange={(event) => setLocal({ ...local, starts_on: event.target.value })} />
      <input aria-label="Term end" type="date" value={local.ends_on} onChange={(event) => setLocal({ ...local, ends_on: event.target.value })} />
    </> : <><b>{term.label}</b><span>{formatDate(term.starts_on)}–{formatDate(term.ends_on)} · {yearLabel}</span></>}
    <div className="row-actions">
      {editing ? <><button onClick={() => { onSave(local); setEditing(false); }}>Save</button><button onClick={() => { setLocal(term); setEditing(false); }}>Cancel</button></> : <><button onClick={startEditing}>Edit</button><button className="danger" onClick={() => onDelete(term)}>Delete</button></>}
    </div>
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
 * Each block also carries its weekday, so the same school year can support more
 * than one co-op day without encoding a day name into a free-text label.
 */
function TimeBlocks({ blocks, years, currentYearId, onSaved, onStatus }: {
  blocks: ClassBlock[]; years: SchoolYear[]; currentYearId: string | null;
  onSaved: () => void; onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [startsAt, setStartsAt] = useState("09:00");
  const [endsAt, setEndsAt] = useState("10:00");
  const [dayOfWeek, setDayOfWeek] = useState(5);
  const [busy, setBusy] = useState(false);

  async function addBlock(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !label.trim()) return;
    if (endsAt <= startsAt) { onStatus("A block has to end after it starts."); return; }
    setBusy(true);
    const { error } = await supabase.from("class_blocks").insert({
      label: label.trim(), starts_at: startsAt, ends_at: endsAt,
      day_of_week: dayOfWeek, school_year_id: currentYearId,
      sort_order: blocks.filter((block) => block.day_of_week === dayOfWeek).length,
    });
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    onStatus(`Added the ${label.trim()} block.`);
    setLabel("");
    onSaved();
  }

  async function saveBlock(block: ClassBlock) {
    if (block.ends_at <= block.starts_at) { onStatus("A block has to end after it starts."); return; }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("class_blocks").update({
      label: block.label.trim(), day_of_week: block.day_of_week,
      starts_at: block.starts_at, ends_at: block.ends_at,
    }).eq("id", block.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`Saved the ${block.label} block.`);
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
      {blocks.map((block) => <TimeBlockRow key={block.id} block={block} yearLabel={block.school_year_id ? years.find((year) => year.id === block.school_year_id)?.label ?? "" : "Every year"} onSave={saveBlock} onDelete={removeBlock} />)}
      {!blocks.length && <p className="portal-empty">No time blocks yet. Add one before scheduling classes.</p>}

      <form onSubmit={addBlock} className="portal-form">
        <label><span className="field-caption">Day</span>
          <select value={dayOfWeek} onChange={(event) => setDayOfWeek(Number(event.target.value))} disabled={busy}>
            {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
        </label>
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

function TimeBlockRow({ block, yearLabel, onSave, onDelete }: {
  block: ClassBlock; yearLabel: string;
  onSave: (block: ClassBlock) => void; onDelete: (block: ClassBlock) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(block);
  // See AcademicTermRow -- local only copies the prop on entering/cancelling
  // edit, never on every parent reload, so an unrelated save elsewhere in the
  // same panel can't silently wipe an in-progress edit here.
  function startEditing() { setLocal(block); setEditing(true); }
  return <div className="child-line term-row">
    {editing ? <>
      <select aria-label="Meeting day" value={local.day_of_week} onChange={(event) => setLocal({ ...local, day_of_week: Number(event.target.value) })}>
        {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
      </select>
      <input aria-label="Block name" value={local.label} onChange={(event) => setLocal({ ...local, label: event.target.value })} />
      <input aria-label="Block start" type="time" value={local.starts_at.slice(0, 5)} onChange={(event) => setLocal({ ...local, starts_at: event.target.value })} />
      <input aria-label="Block end" type="time" value={local.ends_at.slice(0, 5)} onChange={(event) => setLocal({ ...local, ends_at: event.target.value })} />
    </> : <><b>{formatWeekday(block.day_of_week)} · {block.label}</b><span>{formatBlockTime(block)} · {yearLabel}</span></>}
    <div className="row-actions">
      {editing ? <><button onClick={() => { onSave(local); setEditing(false); }}>Save</button><button onClick={() => { setLocal(block); setEditing(false); }}>Cancel</button></> : <><button onClick={startEditing}>Edit</button><button className="danger" onClick={() => onDelete(block)}>Delete</button></>}
    </div>
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

  async function saveRoom(room: Room) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !room.name.trim()) return;
    const { error } = await supabase.from("rooms").update({ name: room.name.trim(), note: room.note?.trim() || null }).eq("id", room.id);
    if (error) { onStatus(error.message.includes("duplicate") ? `There is already a room called "${room.name.trim()}".` : error.message); return; }
    onStatus(`Saved ${room.name.trim()}.`);
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
      {rooms.map((room) => <RoomRow key={room.id} room={room} onSave={saveRoom} onToggle={toggleActive} />)}
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

function RoomRow({ room, onSave, onToggle }: { room: Room; onSave: (room: Room) => void; onToggle: (room: Room) => void }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(room);
  // See AcademicTermRow -- local only copies the prop on entering/cancelling
  // edit, never on every parent reload.
  function startEditing() { setLocal(room); setEditing(true); }
  return <div className="child-line term-row">
    {editing ? <>
      <input aria-label="Room name" value={local.name} onChange={(event) => setLocal({ ...local, name: event.target.value })} />
      <input aria-label="Room note" value={local.note ?? ""} onChange={(event) => setLocal({ ...local, note: event.target.value })} placeholder="Optional note" />
    </> : <><b>{room.name}</b><span>{room.note ? `${room.note} · ` : ""}{room.active ? "In use" : "Retired"}</span></>}
    <div className="row-actions">
      {editing ? <><button onClick={() => { onSave(local); setEditing(false); }}>Save</button><button onClick={() => { setLocal(room); setEditing(false); }}>Cancel</button></> : <><button onClick={startEditing}>Edit</button><button onClick={() => onToggle(room)}>{room.active ? "Retire" : "Bring back"}</button></>}
    </div>
  </div>;
}

function ClassCard({ row, years, blocks, rooms, terms, clash, teacherOptions, childOptions, actorUserId, onSave, onAssignTeacher, onRemoveTeacher, onEnrollChild, onSetEnrollmentStatus }: {
  row: ClassRow; years: SchoolYear[]; blocks: ClassBlock[]; rooms: Room[]; terms: AcademicTerm[]; clash: string | null;
  teacherOptions: TeacherOption[]; childOptions: ChildOption[]; actorUserId: string;
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
  const [rosterOpen, setRosterOpen] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLocal(row); }, [row]);

  const active = row.enrollments.filter((entry) => entry.status === "active");
  const block = blocks.find((option) => option.id === row.block_id) ?? null;
  const room = rooms.find((option) => option.id === row.room_id) ?? null;
  const classTerms = terms.filter((term) => row.term_ids.includes(term.id));
  const availableTerms = terms.filter((term) => !local.school_year_id || term.school_year_id === local.school_year_id);
  const availableBlocks = blocks.filter((option) => !option.school_year_id || !local.school_year_id || option.school_year_id === local.school_year_id);
  const teacherName = (assignment: TeacherAssignment) =>
    teacherOptions.find((option) => option.user_id === assignment.user_id)?.name
      ?? assignment.profiles?.display_name
      ?? assignment.profiles?.email
      ?? "Unnamed";

  return <><CollapsibleRecord
    summary={<b>{row.title}</b>}
    meta={[
      block ? formatBlock(block) : "No time block",
      room?.name,
      classTerms.map((term) => term.label).join(", ") || null,
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
            {availableBlocks.map((option) => <option key={option.id} value={option.id}>{formatBlock(option)}</option>)}
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
          <select value={local.school_year_id ?? ""} onChange={(event) => {
            const schoolYearId = event.target.value || null;
            const keepBlock = blocks.find((option) => option.id === local.block_id);
            setLocal({
              ...local,
              school_year_id: schoolYearId,
              // A term only belongs to one school year, so "Unassigned" has
              // none valid -- `!schoolYearId ||` here used to short-circuit
              // true and keep every existing term_id verbatim in that case,
              // leaving a class that was reassigned to a *different* year
              // later still carrying stale terms from the year before.
              term_ids: schoolYearId ? local.term_ids.filter((termId) => terms.some((term) => term.id === termId && term.school_year_id === schoolYearId)) : [],
              block_id: keepBlock && keepBlock.school_year_id && schoolYearId && keepBlock.school_year_id !== schoolYearId ? null : local.block_id,
            });
          }}>
            <option value="">Unassigned</option>
            {years.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
          </select>
        </Field>
        <Field label="Terms" value={classTerms.map((term) => term.label).join(", ") || "All year / not assigned"} editing={editing}>
          <div className="term-picker">
            {availableTerms.map((term) => <label key={term.id}>
              <input type="checkbox" checked={local.term_ids.includes(term.id)} onChange={(event) => setLocal({
                ...local,
                term_ids: event.target.checked ? [...local.term_ids, term.id] : local.term_ids.filter((id) => id !== term.id),
              })} />
              <span>{term.label}<small>{formatDate(term.starts_on)}–{formatDate(term.ends_on)}</small></span>
            </label>)}
            {!availableTerms.length && <span className="field-note">Create school-year terms in Schedule &amp; enrollment settings first.</span>}
          </div>
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
      <div className="editable-head"><p className="card-kicker">Roster</p><button onClick={() => setRosterOpen(true)}>Printable roster</button></div>
      <SubscribeLink query={`scope=class&id=${row.id}&token=${row.calendar_token}`} label="Subscribe to this class’s calendar" />
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
    <ClassCurriculum classId={row.id} classTitle={row.title} actorUserId={actorUserId} />
  </CollapsibleRecord>
  {rosterOpen && <DetailModal title={`${row.title} roster`} onClose={() => setRosterOpen(false)}>
    <RosterReport row={row} block={block} room={room} teacherName={teacherName} />
  </DetailModal>}
  </>;
}

type ClassFile = { id: string; title: string; kind: string; storage_path: string; created_at: string };

/**
 * Curriculum and handouts for one class, attached from the admin side.
 *
 * Mirrors ResourcesSection in teacher/workspace.tsx -- same documents table,
 * same private bucket. RLS already keeps a "curriculum" file hidden from
 * enrolled families and visible only to that class's teaching team
 * (documents_read's `kind <> 'curriculum'` clause) and already lets any
 * admin write any class's documents, so this is the upload/list UI the
 * teacher side has always had, added here too -- an admin who has the file
 * doesn't have to wait on a teacher account to get it into the class.
 */
function ClassCurriculum({ classId, classTitle, actorUserId }: { classId: string; classTitle: string; actorUserId: string }) {
  const [files, setFiles] = useState<ClassFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("curriculum");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("documents").select("id,title,kind,storage_path,created_at").eq("class_id", classId).order("created_at", { ascending: false });
    setFiles((data ?? []) as ClassFile[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- refetch when the expanded class changes; load() is a fresh closure each render
  useEffect(() => { load(); }, [classId]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !file || !title.trim()) return;
    setBusy(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "handouts", file);
    if ("error" in uploaded) { setStatus(uploaded.error); setBusy(false); return; }
    const { error } = await supabase.from("documents").insert({
      class_id: classId, kind, title: title.trim(), storage_path: uploaded.path, uploaded_by_user_id: actorUserId,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setFile(null); setKind("curriculum"); setStatus("File posted.");
    await load();
  }

  async function download(path: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  async function remove(item: ClassFile) {
    if (!confirm(`Remove "${item.title}"?`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("documents").delete().eq("id", item.id);
    if (error) { setStatus(error.message); return; }
    await load();
  }

  if (loading) return null;

  return <div className="record-section">
    <p className="card-kicker">Curriculum &amp; handouts</p>
    <form onSubmit={upload} className="portal-form">
      <label><span className="field-caption">Title</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${classTitle} scope and sequence`} disabled={busy} />
      </label>
      <label><span className="field-caption">File type</span><select value={kind} onChange={(event) => setKind(event.target.value)} disabled={busy}><option value="curriculum">Curriculum / teacher resource</option><option value="handout">Family handout</option></select></label>
      <label className="file-drop"><span className="field-caption">File</span>
        <input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <button disabled={busy}>{busy ? "Uploading…" : "Upload class file"}</button>
    </form>
    <p className="admin-form-status" role="status">{status}</p>
    <div className="portal-stack portal-stack-tight">
      {files.map((item) => <div key={item.id} className="teacher-class">
        <div><b>{item.title}</b><span>{item.kind === "curriculum" ? "Curriculum -- teacher/assistant only" : "Handout"} · {new Date(item.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</span></div>
        <div className="row-actions"><button onClick={() => download(item.storage_path)}>Open</button><button className="danger" onClick={() => remove(item)}>Remove</button></div>
      </div>)}
      {!files.length && <p className="portal-empty">No files attached to {classTitle} yet.</p>}
    </div>
  </div>;
}

function nameOf(assignment: TeacherAssignment) {
  return assignment.profiles?.display_name || assignment.profiles?.email || "Unassigned";
}

function minGradeIndex(row: ClassRow) {
  const indexes = row.grades.map((grade) => GRADES.indexOf(grade)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : GRADES.length;
}

/**
 * Every class for one school year, one printed page per term, grouped by
 * meeting period within the page -- the shape of the master roster the
 * co-op already builds by hand each year (class / room / age / teacher /
 * assistant / roster / total), just generated from the same records the
 * rest of this tab edits instead of kept separately.
 *
 * A class with no term assigned is treated as year-round (same convention
 * private.classes_terms_overlap uses for the enrollment clash check), so it
 * shows up on every term's page rather than vanishing because nobody
 * happened to assign it one.
 */
function MasterRoster({ classes, blocks, rooms, terms, year }: {
  classes: ClassRow[]; blocks: ClassBlock[]; rooms: Room[]; terms: AcademicTerm[]; year: SchoolYear;
}) {
  const reportRef = useRef<HTMLElement>(null);
  const orderedTerms = [...terms].sort((a, b) => a.sort_order - b.sort_order);
  const pages = orderedTerms.length ? orderedTerms : [null];

  return <div className="roster-report-shell">
    <div className="roster-report-actions no-print"><p>{classes.length} class{classes.length === 1 ? "" : "es"} across {orderedTerms.length || 1} page{orderedTerms.length === 1 ? "" : "s"}</p><button onClick={() => printElement(reportRef.current)}>Print master roster</button></div>
    <section ref={reportRef} className="roster-print-sheet master-roster">
      {pages.map((term, pageIndex) => {
        const forTerm = classes.filter((row) => !term || !row.term_ids.length || row.term_ids.includes(term.id));
        const usedBlockIds = new Set(forTerm.map((row) => row.block_id).filter((id): id is string => !!id));
        const groups: { label: string; rows: ClassRow[] }[] = [
          ...blocks.filter((block) => usedBlockIds.has(block.id)).map((block) => ({
            label: `${block.label} · ${formatWeekday(block.day_of_week)} ${formatBlockTime(block)}`,
            rows: forTerm.filter((row) => row.block_id === block.id).sort((a, b) => minGradeIndex(a) - minGradeIndex(b) || a.title.localeCompare(b.title)),
          })),
          { label: "No time block", rows: forTerm.filter((row) => !row.block_id).sort((a, b) => a.title.localeCompare(b.title)) },
        ].filter((group) => group.rows.length);

        return <div key={term?.id ?? "all"} className={pageIndex < pages.length - 1 ? "master-roster-page" : ""}>
          <div className="roster-print-head"><div><p>VERITAS VILLAGE</p><h2>{year.label} Class Roster{term ? ` – ${term.label}` : ""}</h2></div></div>
          {groups.map((group) => <table key={group.label} className="master-roster-table">
            <thead><tr><th colSpan={7}>{group.label}</th></tr><tr><th>Class</th><th>Room</th><th>Age</th><th>Teacher</th><th>Assistant</th><th>Roster</th><th>Total</th></tr></thead>
            <tbody>{group.rows.map((row) => {
              const room = rooms.find((option) => option.id === row.room_id);
              const roster = row.enrollments.filter((entry) => entry.status === "active" && entry.children?.first_name)
                .map((entry) => entry.children!.first_name).sort((a, b) => a.localeCompare(b));
              return <tr key={row.id}>
                <td>{row.title}</td>
                <td>{room?.name ?? "—"}</td>
                <td>{formatGrades(row.grades)}</td>
                <td>{row.teacher_assignments.filter((a) => a.assignment_role === "lead").map(nameOf).join(", ") || "—"}</td>
                <td>{row.teacher_assignments.filter((a) => a.assignment_role === "assistant").map(nameOf).join(", ") || "—"}</td>
                <td>{roster.join(", ") || "—"}</td>
                <td>{roster.length}</td>
              </tr>;
            })}</tbody>
          </table>)}
          {!groups.length && <p className="portal-empty">No active classes {term ? `in ${term.label}` : "this year"}.</p>}
        </div>;
      })}
    </section>
  </div>;
}

function RosterReport({ row, block, room, teacherName }: {
  row: ClassRow; block: ClassBlock | null; room: Room | null;
  teacherName: (assignment: TeacherAssignment) => string;
}) {
  const reportRef = useRef<HTMLElement>(null);
  const active = row.enrollments.filter((entry) => entry.status === "active")
    .sort((a, b) => `${a.children?.last_name ?? ""}${a.children?.first_name ?? ""}`.localeCompare(`${b.children?.last_name ?? ""}${b.children?.first_name ?? ""}`));

  return <div className="roster-report-shell">
    <div className="roster-report-actions no-print"><p>{active.length} enrolled student{active.length === 1 ? "" : "s"}</p><button onClick={() => printElement(reportRef.current)}>Print roster</button></div>
    <section ref={reportRef} className="roster-print-sheet">
      <div className="roster-print-head"><div><p>VERITAS VILLAGE</p><h2>{row.title}</h2></div><span>{block ? formatBlock(block) : "Time to be announced"}<br/>{room?.name ?? "Room to be announced"}</span></div>
      <dl className="roster-print-meta"><div><dt>Teaching team</dt><dd>{row.teacher_assignments.length ? row.teacher_assignments.map((assignment) => `${teacherName(assignment)} (${assignment.assignment_role})`).join(", ") : "Not assigned"}</dd></div><div><dt>Grades</dt><dd>{formatGrades(row.grades)}</dd></div></dl>
      <table>
        <thead><tr><th>#</th><th>Student</th><th>Grade</th><th>Household</th><th>Attendance / notes</th></tr></thead>
        <tbody>{active.map((entry, index) => <tr key={entry.child_id}><td>{index + 1}</td><td>{entry.children?.first_name} {entry.children?.last_name}</td><td>{entry.children?.age_band ?? "—"}</td><td>{entry.children?.families?.last_name ?? entry.children?.families?.display_name ?? "—"}</td><td /></tr>)}</tbody>
      </table>
      {!active.length && <p className="portal-empty">No students are currently enrolled.</p>}
    </section>
  </div>;
}
