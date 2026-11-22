"use client";

import { useEffect, useId, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { storeAvatar } from "../../../lib/storage";
import { goTo } from "../../../lib/portal-chrome";
import { EditableSection, Field, GRADES } from "../admin/admin-ui";
import { lockReason, togglePick, type ChildDate, type EnrollOption } from "../../../lib/children-view";
import type { ChildOverview, ChildRecord } from "./use-children";

/**
 * The pieces the Today cards, the Children page and the admin's child pop-up
 * share. Each takes rows from use-children.ts and fetches nothing of its own,
 * apart from the one call a button makes.
 */

export function childName(child: Pick<ChildRecord, "first_name" | "last_name" | "last_initial">, full = false) {
  if (full && child.last_name) return `${child.first_name} ${child.last_name}`;
  return child.last_initial ? `${child.first_name} ${child.last_initial}.` : child.first_name;
}

export function gradeLabel(child: Pick<ChildRecord, "age_band" | "age_band_override">) {
  return child.age_band ? `Grade ${child.age_band}${child.age_band_override ? " (set manually)" : ""}` : "Grade not set";
}

function dayLabel(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One assignment with its tick box. The same control on a Today card and on the Children page. */
export function AssignmentCheck({ row, childId, onToggle, showClass = true }: {
  row: ChildDate; childId: string;
  onToggle: (childId: string, eventId: string, done: boolean) => Promise<string>;
  showClass?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const inputId = useId();
  async function change() {
    setBusy(true); setProblem("");
    const message = await onToggle(childId, row.id, row.completed);
    setBusy(false);
    if (message) setProblem(message);
  }
  return <li className={`child-assignment${row.completed ? " done" : ""}`}>
    <label htmlFor={inputId}>
      <input id={inputId} type="checkbox" checked={row.completed} disabled={busy} onChange={change} />
      <b>{row.title}</b>
      <small>{[showClass ? row.classTitle : null, `due ${dayLabel(row.day)}`, row.completed ? "ready" : null].filter(Boolean).join(" · ")}</small>
    </label>
    {problem && <p className="admin-form-status" role="status">{problem}</p>}
  </li>;
}

/** Opens the one thread between this child's teacher and the child's parents (asking again returns the same thread). */
function useMessageTeacher(childId: string) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  async function open(teacherId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setOpeningId(teacherId); setStatus("");
    const { data, error } = await supabase.rpc("start_child_conversation", { p_child_id: childId, p_teacher_id: teacherId });
    if (error || typeof data !== "string") {
      setStatus(error?.message ?? "Could not open the conversation. Try again.");
      setOpeningId(null);
      return;
    }
    goTo(`/family-village/messages?c=${data}`);
  }
  return { openingId, status, open };
}

export function ChildClassList({ entry }: { entry: ChildOverview }) {
  const message = useMessageTeacher(entry.child.id);
  if (!entry.classes.length) return <p className="portal-empty">Not enrolled in any classes yet.</p>;
  return <>
    <ul className="child-detail-list child-class-list">{entry.classes.map((row) => <li key={row.id}>
      <b><a href={`/family-village/classes/view?id=${row.id}`}>{row.title}</a></b>
      <span>{row.when}{row.teachers.length ? ` · ${row.teachers.map((teacher) => teacher.name).join(", ")}` : ""}</span>
      {row.teachers.length > 0 && <div className="row-actions">
        {row.teachers.map((teacher) => <button key={teacher.id} type="button" className="ghost" disabled={message.openingId !== null} onClick={() => message.open(teacher.id)}>
          {message.openingId === teacher.id ? "Opening…" : `Message ${teacher.name}`}
        </button>)}
      </div>}
    </li>)}</ul>
    {message.status && <p className="admin-form-status" role="status">{message.status}</p>}
  </>;
}

/** Assignments (with tick boxes), then the other class dates. */
export function ChildDateSections({ entry, onToggle, headingLevel = "p" }: {
  entry: ChildOverview;
  onToggle: (childId: string, eventId: string, done: boolean) => Promise<string>;
  headingLevel?: "p" | "h4";
}) {
  const Heading = headingLevel;
  const assignments = entry.dates.filter((row) => row.requiresPrework);
  const others = entry.dates.filter((row) => !row.requiresPrework).slice(0, 10);
  return <>
    <section className="child-section">
      <Heading className="card-kicker">Assignments</Heading>
      {assignments.length
        ? <ul className="child-assignments">{assignments.map((row) => <AssignmentCheck key={row.id} row={row} childId={entry.child.id} onToggle={onToggle} />)}</ul>
        : <p className="portal-empty">No assignments due.</p>}
    </section>
    <section className="child-section">
      <Heading className="card-kicker">Coming up in class</Heading>
      {others.length
        ? <ul className="child-detail-list">{others.map((row) => <li key={row.id}>
            <b>{row.title}</b>
            <span>{[row.classTitle, dayLabel(row.day), row.location].filter(Boolean).join(" · ")}</span>
          </li>)}</ul>
        : <p className="portal-empty">Nothing else scheduled in {entry.child.first_name}&rsquo;s classes right now.</p>}
    </section>
  </>;
}

/**
 * Photo, "goes by", birthdate and grade: the only things a family may change
 * about a child. The database enforces the same boundary (a trigger rejects any
 * other column in the update), so this is convenience, not the real gate.
 */
export function ChildDetailsEditor({ child, onSaved, startEditing = false, onCancel }: {
  child: ChildRecord;
  onSaved: () => Promise<void> | void;
  startEditing?: boolean;
  onCancel?: () => void;
}) {
  const [status, setStatus] = useState("");
  const [firstName, setFirstName] = useState(child.first_name);
  const [birthdate, setBirthdate] = useState<string | null>(child.birthdate);
  const [override, setOverride] = useState(child.age_band_override);
  const [grade, setGrade] = useState<string | null>(child.age_band);

  function resetForm() {
    setFirstName(child.first_name); setBirthdate(child.birthdate); setOverride(child.age_band_override); setGrade(child.age_band);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync the staged values whenever fresh data loads
  useEffect(resetForm, [child]);

  async function update(patch: Partial<Pick<ChildRecord, "avatar_path" | "first_name" | "birthdate" | "age_band_override" | "age_band">>, savedMessage = "Saved.") {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return false;
    const { error } = await supabase.from("children").update(patch).eq("id", child.id);
    if (error) { setStatus(error.message); return false; }
    setStatus(savedMessage);
    await onSaved();
    return true;
  }

  async function uploadAvatar(file: File) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setStatus("Uploading…");
    const uploaded = await storeAvatar(supabase, file);
    if ("error" in uploaded) { setStatus(uploaded.error); return; }
    await update({ avatar_path: uploaded.path }, "Photo updated.");
  }

  return <section>
    <EditableSection
      label="Details"
      startEditing={startEditing}
      onSave={async () => { await update({
        first_name: firstName.trim() || child.first_name,
        birthdate: birthdate || null,
        age_band_override: override,
        ...(override ? { age_band: grade } : {}),
      }); }}
      onCancel={() => { resetForm(); onCancel?.(); }}
    >
      {(editing) => <div className="field-grid">
        {editing && <label className="file-drop"><span className="field-caption">Photo</span>
          <input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadAvatar(file); }} />
        </label>}
        <Field label="Goes by" value={child.first_name} editing={editing}>
          <input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
        </Field>
        <Field
          label="Birthdate"
          value={child.birthdate ? new Date(child.birthdate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null}
          editing={editing}
        >
          <input type="date" value={birthdate ?? ""} onChange={(event) => setBirthdate(event.target.value || null)} />
        </Field>
        {editing && <label className="checkbox-field">
          <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} /> Set grade manually
        </label>}
        <Field label="Grade" value={child.age_band ? gradeLabel(child) : null} editing={editing && override}>
          <select value={grade ?? ""} onChange={(event) => setGrade(event.target.value || null)}>
            <option value="">Not set</option>
            {GRADES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        {editing && !override && <p className="field-note">
          {birthdate ? "Grade is calculated automatically from birthdate." : "Add a birthdate to calculate grade automatically."}
        </p>}
      </div>}
    </EditableSection>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </section>;
}

/**
 * The classes a child can pick in the open window. Full classes and ones with
 * prerequisites still to do stay in the list, greyed out with the reason.
 * Picking a class drops another pick at the same time.
 */
export function EnrollOptionsList({ child, options, picks, onChange }: {
  child: ChildRecord; options: EnrollOption[]; picks: string[]; onChange: (picks: string[]) => void;
}) {
  if (!child.age_band) return <p className="portal-empty">{child.first_name} has no grade yet, so no classes can be matched. Add a birthdate or a grade with Edit first.</p>;
  if (!options.length) return <p className="portal-empty">No open classes match {child.first_name}&rsquo;s grade right now.</p>;
  return <div className="enrollment-class-options" role="group" aria-label={`Classes available to ${child.first_name}`}>
    {options.map((option) => {
      const reason = lockReason(option);
      const picked = picks.includes(option.id);
      const inputId = `enroll-${child.id}-${option.id}`;
      return <div key={option.id} className={`${picked ? "selected" : ""}${reason ? " disabled" : ""}`}>
        <input id={inputId} type="checkbox" checked={picked} disabled={!!reason} onChange={() => onChange(togglePick(picks, option, options))} />
        <label htmlFor={inputId}>
          <b>{option.title}</b>
          <small>{[option.when, reason].filter(Boolean).join(" · ")}</small>
          <p>{option.description || "No class description has been added yet."}</p>
        </label>
      </div>;
    })}
  </div>;
}
