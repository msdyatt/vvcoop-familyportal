"use client";

import { ReactNode, useId, useState } from "react";
import DetailModal from "../detail-modal";

/**
 * Shared shape for the admin lists.
 *
 * Both Families and Classes previously rendered every record as a wall of live
 * text inputs. At two records that is merely untidy; at forty households or
 * twenty classes it is unusable, and a stray click edits data. Everything
 * collapses to a summary line, opens read-only, and only becomes editable when
 * someone asks for it.
 */
export function CollapsibleRecord({ summary, meta, chips, defaultOpen = false, children }: {
  summary: ReactNode;
  meta?: ReactNode;
  chips?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return <article className={`record${open ? " open" : ""}`}>
    <button className="record-head" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary">{summary}</span>
      {meta && <span className="record-meta">{meta}</span>}
      {chips && <span className="record-chips">{chips}</span>}
    </button>
    {open && <div className="record-body" id={panelId}>{children}</div>}
  </article>;
}

/**
 * Read-only until asked. `render` receives whether the section is in edit mode,
 * so a caller shows text or inputs from one definition rather than maintaining
 * two parallel trees that can drift apart.
 */
export function EditableSection({ label, onSave, onCancel, children }: {
  label: string;
  onSave: () => Promise<void> | void;
  onCancel?: () => void;
  children: (editing: boolean) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await onSave();
    setBusy(false);
    setEditing(false);
  }

  return <div className="editable">
    <div className="editable-head">
      <p className="card-kicker">{label}</p>
      {editing
        ? <div className="row-actions">
            <button disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
            <button className="ghost" disabled={busy} onClick={() => { onCancel?.(); setEditing(false); }}>Cancel</button>
          </div>
        : <button onClick={() => setEditing(true)}>Edit {label.toLowerCase()}</button>}
    </div>
    {children(editing)}
  </div>;
}

/** Shows a value as plain text, or as the supplied control while editing. */
export function Field({ label, value, editing, children }: {
  label: string;
  value: ReactNode;
  editing: boolean;
  children: ReactNode;
}) {
  return <div className="field">
    <span className="field-label">{label}</span>
    {editing ? children : <span className="field-value">{value || <em>Not set</em>}</span>}
  </div>;
}

export const GRADES = ["Pre-K", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

/**
 * Grades a class covers.
 *
 * A co-op combines age groups when a class would otherwise be too small, so one
 * class routinely spans several grades -- which the old free-text "age band"
 * box could not express without everyone inventing their own notation.
 */
export function GradePicker({ selected, onChange, disabled }: {
  selected: string[];
  onChange: (grades: string[]) => void;
  disabled?: boolean;
}) {
  function toggle(grade: string) {
    onChange(selected.includes(grade) ? selected.filter((g) => g !== grade) : [...selected, grade]);
  }

  return <div className="grade-picker" role="group" aria-label="Grades">
    {GRADES.map((grade) => <button
      key={grade} type="button" disabled={disabled}
      className={`grade-chip${selected.includes(grade) ? " on" : ""}`}
      aria-pressed={selected.includes(grade)}
      onClick={() => toggle(grade)}>{grade}</button>)}
    {selected.length === 0 && <span className="grade-hint">Any grade</span>}
  </div>;
}

/** Grades in reading order, collapsing runs -- "K–3, 7" rather than a long list. */
export function formatGrades(grades: string[] | null): string {
  if (!grades?.length) return "Any grade";
  const ordered = GRADES.filter((grade) => grades.includes(grade));
  const runs: string[][] = [];
  ordered.forEach((grade) => {
    const last = runs[runs.length - 1];
    if (last && GRADES.indexOf(grade) === GRADES.indexOf(last[last.length - 1]) + 1) last.push(grade);
    else runs.push([grade]);
  });
  return runs.map((run) => (run.length > 2 ? `${run[0]}–${run[run.length - 1]}` : run.join(", "))).join(", ");
}

/**
 * A second, deliberate confirmation for a delete that's hard or impossible
 * to undo -- typing the word beats a plain confirm() dialog, which a
 * reflexive click-through defeats in a way a typed word doesn't.
 *
 * Case-insensitive, trimmed -- the point is a deliberate act, not a typing
 * test.
 */
export function ConfirmDeleteModal({ title, description, confirmWord = "DELETE", confirmLabel, busy = false, onConfirm, onCancel }: {
  title: string; description: ReactNode; confirmWord?: string; confirmLabel?: string; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = typed.trim().toUpperCase() === confirmWord.toUpperCase();

  return <DetailModal title={title} onClose={onCancel}>
    <div className="portal-form">
      <p className="portal-empty">{description}</p>
      <label><span className="field-caption">Type {confirmWord} to confirm</span>
        <input
          value={typed} onChange={(event) => setTyped(event.target.value)}
          placeholder={confirmWord} disabled={busy} autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- this field is the only thing on the modal, so focusing it follows the reason it was opened
          autoFocus
        />
      </label>
      <div className="row-actions">
        <button className="danger" disabled={busy || !ready} onClick={onConfirm}>{busy ? "Working…" : confirmLabel ?? `${confirmWord === "DELETE" ? "Delete" : "Remove"} permanently`}</button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  </DetailModal>;
}
