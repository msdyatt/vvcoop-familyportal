"use client";

import { useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { SchoolYear } from "../../../lib/compliance";
import { PlacementReport, PlacementReportData } from "./grade-placement";

/**
 * Start next school year.
 *
 * Four steps -- which years, what to copy, which households are coming back,
 * and a preview -- and nothing is written until the last button. The preview is
 * the database running the whole copy and undoing it, so the counts on screen
 * are the counts the real run produces. Students are never copied; households
 * that are not returning keep their accounts and are only left out of the new
 * year's dues, document requests and reports.
 */

type OptionKey =
  | "blocks_rooms" | "terms" | "classes" | "teachers" | "document_requirements"
  | "dues_requirements" | "enrollment_windows" | "open_requirements" | "place_children";

const OPTIONS: { key: OptionKey; label: string; hint: string }[] = [
  { key: "blocks_rooms", label: "Meeting blocks and rooms", hint: "The weekly time slots, and the room each class uses. Rooms are shared by every year." },
  { key: "terms", label: "Terms", hint: "Dates move forward a year. You can change them below." },
  { key: "classes", label: "Classes", hint: "Title, description, grades, capacity, time block and room. Retired classes stay behind. Students are not copied: families choose classes again in the enrollment window." },
  { key: "teachers", label: "Teacher assignments", hint: "Only teachers whose accounts are still active." },
  { key: "document_requirements", label: "Required documents", hint: "Same documents, due dates a year later. Nothing anyone signed carries over." },
  { key: "dues_requirements", label: "Dues", hint: "Same amounts, payment link and monthly plan choice, due dates a year later." },
  { key: "enrollment_windows", label: "Enrollment windows", hint: "Dates move forward a year, and each window starts closed." },
  { key: "place_children", label: "Place children in grade-based classes", hint: "Children of the returning households go into the History, Science and other grade-assigned classes for their grade in the new year (one grade up for most). Nothing placed by hand is touched, a full class waitlists, and electives stay with families. You see exactly who is placed, and who could not be and why, before you confirm. You can run it again any time under Grade-based placement." },
  { key: "open_requirements", label: "Ask returning households for the new year's documents and dues now", hint: "They appear in each returning household's Paperwork and Dues straight away, even before the new year is current. Untick to open them later." },
];

type Household = { family_id: string; display_name: string; last_name: string | null; adults: number; children: number; status: string; decided: boolean };
type TermRow = { id: string; label: string; starts_on: string; ends_on: string };
type Counts = Record<string, number>;
type Result = {
  source: string; target: string; shift_years: number;
  copied: Counts; already_there: Counts;
  households: { moving_forward: number; not_returning: number; changed: number };
  opened: { document_rows: number; dues_charges: number };
  made_current?: boolean;
  placement?: PlacementReportData | null;
};

const STEPS = ["Years", "What to copy", "Households", "Review"];

function plural(count: number, one: string, many = `${one}s`) { return `${count} ${count === 1 ? one : many}`; }

function yearsBetween(source: SchoolYear | undefined, target: SchoolYear | undefined) {
  const a = Number(source?.starts_on?.slice(0, 4));
  const b = Number(target?.starts_on?.slice(0, 4));
  const diff = a && b ? b - a : 0;
  return diff || 1;
}

/** The same date a number of years later; 29 February lands on the 28th, as it does in the database. */
function shiftDate(value: string, years: number) {
  const [y, m, d] = value.split("-").map(Number);
  const moved = new Date(Date.UTC(y + years, m - 1, d));
  if (moved.getUTCMonth() !== m - 1) moved.setUTCDate(0);
  return moved.toISOString().slice(0, 10);
}

/** The label for the year after this one, written the way this one is ("2026-27" or "2026-2027"). */
function nextYearLabel(label: string) {
  const match = /^(\d{4})-(\d{2}|\d{4})$/.exec(label.trim());
  if (!match) return "";
  const start = Number(match[1]) + 1;
  return match[2].length === 2 ? `${start}-${String((start + 1) % 100).padStart(2, "0")}` : `${start}-${start + 1}`;
}

function householdName(row: Household) { return row.last_name || row.display_name; }

export default function YearRollover({ years, onSaved, onStatus }: {
  years: SchoolYear[];
  onSaved: () => void;
  onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [chosenSource, setChosenSource] = useState("");
  const [chosenTarget, setChosenTarget] = useState("");
  const [options, setOptions] = useState<Record<OptionKey, boolean>>({
    blocks_rooms: true, terms: true, classes: true, teachers: true, document_requirements: true,
    dues_requirements: true, enrollment_windows: true, open_requirements: true, place_children: true,
  });
  const [termRows, setTermRows] = useState<TermRow[]>([]);
  const [termEdits, setTermEdits] = useState<Record<string, { starts_on?: string; ends_on?: string }>>({});
  const [households, setHouseholds] = useState<Household[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<Result | null>(null);
  const [makeCurrent, setMakeCurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sorted = useMemo(() => [...years].sort((a, b) => a.label.localeCompare(b.label)), [years]);
  const sourceId = chosenSource || years.find((year) => year.is_current)?.id || sorted[sorted.length - 1]?.id || "";
  const source = years.find((year) => year.id === sourceId);
  const suggestedTarget = sorted.find((year) => year.id !== sourceId && source && year.label > source.label);
  const targetId = chosenTarget && chosenTarget !== sourceId ? chosenTarget : suggestedTarget?.id ?? "";
  const target = years.find((year) => year.id === targetId);
  const shift = yearsBetween(source, target);

  // The year after the source, offered when it does not exist yet.
  const startYear = Number(source?.label.slice(0, 4));
  const nextLabel = source ? nextYearLabel(source.label) : "";
  const canAddNext = !!nextLabel && !years.some((year) => year.label === nextLabel);

  const effectiveTerms = termRows.map((term) => ({
    id: term.id, label: term.label,
    starts_on: termEdits[term.id]?.starts_on ?? shiftDate(term.starts_on, shift),
    ends_on: termEdits[term.id]?.ends_on ?? shiftDate(term.ends_on, shift),
  }));
  const termProblem = options.terms && effectiveTerms.some((term) => !term.starts_on || !term.ends_on || term.ends_on < term.starts_on);

  function reset() {
    setStep(0); setChosenSource(""); setChosenTarget(""); setTermRows([]); setTermEdits({}); setHouseholds([]);
    setTicked(new Set()); setFilter(""); setPreview(null); setMakeCurrent(false); setError("");
  }

  async function addNextYear() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !canAddNext) return;
    setBusy(true); setError("");
    const { data, error: insertError } = await supabase.from("school_years")
      .insert({ label: nextLabel, starts_on: `${startYear + 1}-08-01`, ends_on: `${startYear + 2}-06-30`, is_current: false })
      .select("id").single();
    setBusy(false);
    if (insertError) { setError(insertError.message); return; }
    setChosenTarget(data.id);
    onStatus(`Added ${nextLabel}. It is not current; nothing has been copied into it yet.`);
    onSaved();
  }

  async function toCopyStep() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !source || !target) return;
    setBusy(true); setError("");
    const { data, error: loadError } = await supabase.from("academic_terms")
      .select("id,label,starts_on,ends_on").eq("school_year_id", source.id).order("sort_order").order("starts_on");
    setBusy(false);
    if (loadError) { setError(loadError.message); return; }
    setTermRows((data ?? []) as TermRow[]);
    setTermEdits({});
    setPreview(null);
    setStep(1);
  }

  async function toHouseholdsStep() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !target) return;
    setBusy(true); setError("");
    const { data, error: loadError } = await supabase.rpc("admin_rollover_households", { p_year: target.id });
    setBusy(false);
    if (loadError) { setError(loadError.message); return; }
    const rows = (data ?? []) as Household[];
    setHouseholds(rows);
    // Everyone moves forward unless an earlier run already recorded otherwise.
    const decided = rows.some((row) => row.decided);
    setTicked(new Set(rows.filter((row) => !decided || row.status === "returning").map((row) => row.family_id)));
    setPreview(null);
    setStep(2);
  }

  function rpcArgs() {
    return {
      p_source: sourceId,
      p_target: targetId,
      p_options: options,
      p_returning: [...ticked],
      p_terms: options.terms ? effectiveTerms.map((term) => ({ source_id: term.id, starts_on: term.starts_on, ends_on: term.ends_on })) : null,
    };
  }

  async function toReviewStep() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setError("");
    const { data, error: previewError } = await supabase.rpc("admin_rollover_preview", rpcArgs());
    setBusy(false);
    if (previewError) { setError(previewError.message); return; }
    setPreview(data as Result);
    setStep(3);
  }

  async function confirm() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !target || !source) return;
    setBusy(true); setError("");
    const { data, error: runError } = await supabase.rpc("admin_rollover_school_year", { ...rpcArgs(), p_make_current: makeCurrent });
    setBusy(false);
    if (runError) { setError(runError.message); return; }
    const result = data as Result;
    const copied = result.copied;
    const parts = [
      copied.classes ? plural(copied.classes, "class", "classes") : "",
      copied.blocks ? plural(copied.blocks, "meeting block") : "",
      copied.terms ? plural(copied.terms, "term") : "",
      (copied.document_requirements + copied.dues_requirements) ? plural(copied.document_requirements + copied.dues_requirements, "requirement") : "",
      copied.enrollment_windows ? plural(copied.enrollment_windows, "enrollment window") : "",
    ].filter(Boolean);
    const placement = result.placement;
    const placementNote = placement
      ? ` ${(placement.counts.placed ?? 0) + (placement.counts.promoted ?? 0)} grade-based placements made${placement.items.some((item) => ["no_grade", "no_class", "clash", "waitlisted"].includes(item.outcome)) ? "; some children need attention (see Grade-based placement)" : ""}.`
      : "";
    onStatus(`${result.target} is set up${parts.length ? `: ${parts.join(", ")} copied` : ""}. ${plural(result.households.moving_forward, "household")} moving forward${result.households.not_returning ? `, ${result.households.not_returning} not returning` : ""}. ${result.made_current ? `${result.target} is now the current school year.` : source.is_current ? `${result.source} is still the current school year.` : "The current school year did not change."}${placementNote}`);
    reset();
    setOpen(false);
    onSaved();
  }

  const visibleHouseholds = households.filter((row) => householdName(row).toLowerCase().includes(filter.trim().toLowerCase()));

  function toggleOption(key: OptionKey, value: boolean) {
    setOptions((current) => ({ ...current, [key]: value }));
  }

  return <div className="record-section school-years year-rollover">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Start next school year</b></span>
      <span className="record-meta">Copy a year forward and choose who is returning</span>
    </button>
    {open && <div className="record-body">
      <ol className="rollover-steps" aria-label="Steps">
        {STEPS.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}>
          <span>{index + 1}</span> {label}
        </li>)}
      </ol>
      {error && <p className="admin-form-status" role="alert">{error}</p>}

      {step === 0 && <div className="rollover-panel">
        <p className="sign-hint">Nothing is written until the last step, and the current school year does not change unless you ask on that step.</p>
        <label><span className="field-caption">Copy from</span>
          <select value={sourceId} onChange={(event) => { setChosenSource(event.target.value); setChosenTarget(""); }}>
            {sorted.map((year) => <option key={year.id} value={year.id}>{year.label}{year.is_current ? " (current)" : ""}</option>)}
          </select>
        </label>
        <label><span className="field-caption">Into</span>
          <select value={targetId} onChange={(event) => setChosenTarget(event.target.value)}>
            <option value="">Choose a year</option>
            {sorted.filter((year) => year.id !== sourceId).map((year) => <option key={year.id} value={year.id}>{year.label}{year.is_current ? " (current)" : ""}</option>)}
          </select>
        </label>
        {canAddNext && <div className="row-actions">
          <button type="button" className="ghost" disabled={busy} onClick={addNextYear}>Add {nextLabel}</button>
          <span className="sign-hint">{nextLabel} does not exist yet.</span>
        </div>}
        {target?.is_current && <p className="sign-hint">{target.label} is the current year. Copying into it works, but families will see the new items right away.</p>}
        <div className="row-actions">
          <button type="button" disabled={busy || !source || !target} onClick={toCopyStep}>Next: what to copy</button>
        </div>
      </div>}

      {step === 1 && <div className="rollover-panel">
        <p className="sign-hint">From {source?.label} into {target?.label}. Anything already in {target?.label} is skipped, so nothing is copied twice.</p>
        <ul className="rollover-options">
          {OPTIONS.map((option) => {
            const disabled = option.key === "teachers" && !options.classes;
            return <li key={option.key}>
              <label className="checkbox-field">
                <input type="checkbox" checked={options[option.key] && !disabled} disabled={disabled}
                  onChange={(event) => toggleOption(option.key, event.target.checked)} />
                <b>{option.label}</b>
                <span className="sign-hint">{option.hint}</span>
              </label>
            </li>;
          })}
        </ul>
        {options.terms && <div className="rollover-terms">
          <p className="field-caption">Term dates in {target?.label}</p>
          {!termRows.length && <p className="sign-hint">{source?.label} has no terms to copy.</p>}
          {effectiveTerms.map((term) => <div className="rollover-term" key={term.id}>
            <b>{term.label}</b>
            <label><span className="field-caption">Starts</span>
              <input type="date" value={term.starts_on} onChange={(event) => setTermEdits((current) => ({ ...current, [term.id]: { ...current[term.id], starts_on: event.target.value } }))} />
            </label>
            <label><span className="field-caption">Ends</span>
              <input type="date" value={term.ends_on} onChange={(event) => setTermEdits((current) => ({ ...current, [term.id]: { ...current[term.id], ends_on: event.target.value } }))} />
            </label>
          </div>)}
          {termProblem && <p className="admin-form-status" role="alert">Each term has to end on or after the day it starts.</p>}
        </div>}
        <div className="row-actions">
          <button type="button" className="ghost" onClick={() => setStep(0)}>Back</button>
          <button type="button" disabled={busy || !!termProblem} onClick={toHouseholdsStep}>Next: households</button>
        </div>
      </div>}

      {step === 2 && <div className="rollover-panel">
        <p className="sign-hint">Tick the households moving forward into {target?.label}. A household left unticked keeps its account and login. It is not deleted, deactivated or invited to anything; it is only left out of {target?.label}&rsquo;s dues, document requests and reports, and you can change that later. Children go with their household.</p>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={() => setTicked(new Set(households.map((row) => row.family_id)))}>Select all</button>
          <button type="button" className="ghost" onClick={() => setTicked(new Set())}>Select none</button>
          <strong className="compliance-summary">{ticked.size} of {households.length} moving forward</strong>
        </div>
        <input type="search" placeholder="Filter households" aria-label="Filter households" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <ul className="send-families rollover-households">
          {visibleHouseholds.map((row) => <li key={row.family_id}>
            <label className="checkbox-field">
              <input type="checkbox" checked={ticked.has(row.family_id)} onChange={(event) => setTicked((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(row.family_id); else next.delete(row.family_id);
                return next;
              })} />
              <span>{householdName(row)} <span className="sign-hint">({plural(row.adults, "adult")}, {plural(row.children, "child", "children")})</span></span>
            </label>
          </li>)}
          {!visibleHouseholds.length && <li className="portal-empty">No households match.</li>}
        </ul>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={() => setStep(1)}>Back</button>
          <button type="button" disabled={busy} onClick={toReviewStep}>{busy ? "Checking…" : "Next: review"}</button>
        </div>
      </div>}

      {step === 3 && preview && <div className="rollover-panel">
        <ReviewSummary result={preview} options={options} />
        <label className="checkbox-field">
          <input type="checkbox" checked={makeCurrent} onChange={(event) => setMakeCurrent(event.target.checked)} />
          <b>Also make {preview.target} the current school year</b>
          <span className="sign-hint">Leave this off to keep running {preview.source} until you are ready. Reports, dues and every child&rsquo;s grade follow the current year. You can use Make current under School years any time.</span>
        </label>
        <div className="row-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => setStep(2)}>Back</button>
          <button type="button" className="make-current" disabled={busy} onClick={confirm}>{busy ? "Starting…" : `Start ${preview.target}`}</button>
        </div>
      </div>}
    </div>}
    <ReturningHouseholds years={sorted} defaultYearId={targetId} onStatus={onStatus} />
  </div>;
}

function ReviewSummary({ result, options }: { result: Result; options: Record<OptionKey, boolean> }) {
  const { copied, already_there: existing, households, opened } = result;
  const headline = [
    plural(copied.classes, "class", "classes"),
    plural(copied.blocks, "block"),
    plural(households.moving_forward, "household") + " moving forward",
  ].join(", ");
  // Each line: what it is called for one and for many, how many are copied, how many were already there.
  const rows: [string, string, number, number][] = [
    ["class", "classes", copied.classes, existing.classes],
    ["meeting block", "meeting blocks", copied.blocks, existing.blocks],
    ["term", "terms", copied.terms, existing.terms],
    ["required document", "required documents", copied.document_requirements, existing.document_requirements],
    ["dues item", "dues items", copied.dues_requirements, existing.dues_requirements],
    ["enrollment window", "enrollment windows", copied.enrollment_windows, existing.enrollment_windows],
  ];
  const nothingNew = rows.every(([, , added]) => added === 0) && opened.document_rows === 0 && opened.dues_charges === 0 && households.changed === 0;
  return <div className="rollover-review">
    <p className="rollover-headline">{headline}</p>
    <p className="sign-hint">Copying {result.source} into {result.target}. Dates move forward {plural(result.shift_years, "year")}.</p>
    <ul>
      {rows.filter(([, , added, there]) => added > 0 || there > 0).map(([one, many, added, there]) => <li key={one}>
        <b>{added}</b> {added === 1 ? one : many} will be copied{there > 0 ? `, ${there} already there` : ""}
      </li>)}
      {options.classes && copied.teacher_assignments > 0 && <li><b>{copied.teacher_assignments}</b> teacher {copied.teacher_assignments === 1 ? "assignment" : "assignments"}</li>}
      <li><b>{households.moving_forward}</b> {households.moving_forward === 1 ? "household" : "households"} moving forward{households.not_returning ? `, ${households.not_returning} not returning (accounts untouched)` : ""}</li>
      {(opened.document_rows > 0 || opened.dues_charges > 0) && <li>Opening to returning households: <b>{opened.document_rows}</b> document {opened.document_rows === 1 ? "request" : "requests"} and <b>{opened.dues_charges}</b> dues {opened.dues_charges === 1 ? "charge" : "charges"}</li>}
      <li>No students are copied, and nobody is invited or notified.</li>
    </ul>
    {nothingNew && !result.placement && <p className="sign-hint">Everything chosen is already in {result.target}, so confirming changes nothing.</p>}
    {result.placement && <PlacementReport report={result.placement} preview />}
  </div>;
}

/** Changing a household's answer after the fact: coming back, or (while nothing has happened for it yet) leaving. */
function ReturningHouseholds({ years, defaultYearId, onStatus }: { years: SchoolYear[]; defaultYearId: string; onStatus: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [chosenYear, setChosenYear] = useState("");
  const [rows, setRows] = useState<Household[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const yearId = chosenYear || defaultYearId || years.find((year) => !year.is_current)?.id || "";
  const year = years.find((entry) => entry.id === yearId);

  async function load(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !id) return;
    setError("");
    const { data, error: loadError } = await supabase.rpc("admin_rollover_households", { p_year: id });
    if (loadError) { setError(loadError.message); return; }
    setRows((data ?? []) as Household[]);
  }

  async function toggle(row: Household) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !year) return;
    const returning = row.status !== "returning";
    setBusy(row.family_id); setError("");
    const { error: saveError } = await supabase.rpc("admin_set_household_returning", { p_year: year.id, p_family: row.family_id, p_returning: returning });
    setBusy(null);
    if (saveError) { setError(saveError.message); return; }
    onStatus(returning
      ? `The ${householdName(row)} household is returning for ${year.label}. That year's documents and dues are now open to them.`
      : `The ${householdName(row)} household is not returning for ${year.label}. Their account is untouched.`);
    await load(year.id);
  }

  const visible = rows.filter((row) => householdName(row).toLowerCase().includes(filter.trim().toLowerCase()));
  const leaving = rows.filter((row) => row.status !== "returning").length;

  return <div className="rollover-returning">
    <button className="record-head" aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void load(yearId); }}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Who is returning</b></span>
      <span className="record-meta">Change a household&rsquo;s answer for a year</span>
    </button>
    {open && <div className="record-body">
      <label><span className="field-caption">School year</span>
        <select value={yearId} onChange={(event) => { setChosenYear(event.target.value); void load(event.target.value); }}>
          {years.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{entry.is_current ? " (current)" : ""}</option>)}
        </select>
      </label>
      <p className="sign-hint">A household that is not returning is left out of {year?.label ?? "that year"}&rsquo;s dues, document requests and reports. Its account and login are never touched. Marking one as returning opens that year&rsquo;s documents and dues to it. A household that has already signed or paid for the year cannot be marked as not returning.</p>
      {error && <p className="admin-form-status" role="alert">{error}</p>}
      <p className="compliance-summary">{rows.length - leaving} returning, {leaving} not returning</p>
      <input type="search" placeholder="Filter households" aria-label="Filter households" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <ul className="send-families rollover-households">
        {visible.map((row) => <li key={row.family_id} className="rollover-household-line">
          <span>{householdName(row)} <span className={`status-pill ${row.status === "returning" ? "complete" : "waived"}`}>{row.status === "returning" ? "Returning" : "Not returning"}</span></span>
          <button type="button" className="ghost" disabled={busy === row.family_id} onClick={() => toggle(row)}>
            {row.status === "returning" ? "Mark not returning" : "Mark returning"}
          </button>
        </li>)}
      </ul>
    </div>}
  </div>;
}
