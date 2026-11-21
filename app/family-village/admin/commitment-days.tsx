"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { downloadCsv, toCsv } from "../../../lib/csv";
import { docToRows } from "../../../lib/report-doc";
import { deliverPdf, makePdf } from "../../../lib/report-pdf";
import {
  ROLE_LABEL, balanceText, buildPointsDoc, byBalance, dayLabel, shiftLabel,
  type CoopDay, type DaysData, type PointsHousehold,
} from "../../../lib/teaching-commitment";
import DetailModal from "../detail-modal";

/**
 * Admin, Teaching commitment: the Points and Co-op days views (migration 20261121100000_coop_days_coverage).
 * Points are worked out in the database (private.commitment_points); this shows them and edits the days.
 */

export function useDaysData(yearId: string | null) {
  const [data, setData] = useState<DaysData | null>(null);
  const [problem, setProblem] = useState("");
  const reload = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return null;
    const { data: next, error } = await supabase.rpc("admin_commitment_days", { p_school_year_id: yearId });
    if (error) { setProblem(error.message); return null; }
    setData(next as DaysData); setProblem("");
    return next as DaysData;
  }, [yearId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when the year changes
  useEffect(() => { void reload(); }, [reload]);
  return { data, problem, reload };
}

// --- Points ---------------------------------------------------------------------------------------------------------------

export function PointsView({ yearId }: { yearId: string | null }) {
  const { data, problem, reload } = useDaysData(yearId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const households = useMemo(() => byBalance(data?.households ?? []), [data]);

  if (problem && !data) return <p className="admin-form-status" role="alert">{problem}</p>;
  if (!data) return <p className="portal-empty" role="status">Working out the points…</p>;
  if (!data.school_year) return <p className="portal-empty">There is no school year yet.</p>;
  const terms = data.terms ?? [];
  const people = data.people ?? [];
  const s = data.settings;
  const behind = households.filter((household) => household.balance < 0).length;
  const columnCount = 1 + terms.length * 3 + 4;

  async function exportAs(kind: "pdf" | "csv") {
    if (!data) return;
    const doc = buildPointsDoc(data);
    const filename = `teaching-commitment-points-${(data.school_year?.label ?? "year").replace(/[^a-z0-9]+/gi, "-")}-${new Date().toISOString().slice(0, 10)}`;
    if (kind === "csv") { downloadCsv(`${filename}.csv`, toCsv(docToRows(doc))); return; }
    setBusy(true); setStatus("Preparing the PDF…");
    try {
      const delivery = await deliverPdf(await makePdf(doc), `${filename}.pdf`);
      setStatus(delivery === "shared" ? "" : delivery === "opened" ? "Opened the PDF." : "Saved the PDF.");
    } catch { setStatus("The PDF could not be made. Try again."); } finally { setBusy(false); }
  }

  const toggle = (id: string) => { const next = new Set(open); if (next.has(id)) next.delete(id); else next.add(id); setOpen(next); };

  return <>
    <p className="field-note">
      Each co-op day a household attended, it is expected to earn {data.day_points} points (teach {s.teach_target} × {s.teach_points},
      assist {s.assist_target} × {s.assist_points}; hall monitor earns {s.hall_points}). Shifts are assumed worked unless the person
      said they could not come; covering someone earns their points. Days the household was not there, cancelled days and days
      still to come do not count. A term with no co-op days set up counts as one day.
    </p>
    <p className="tc-summary" role="status">
      <span className={`tc-chip ${behind ? "short" : "ok"}`}>{behind ? `${behind} of ${households.length} households behind` : "No household is behind"}</span>
    </p>
    <div className="tc-scroller" role="region" aria-label="Points by household">
      <table className="tc-table">
        <thead>
          <tr>
            <th rowSpan={2} className="tc-name" scope="col">Household</th>
            {terms.map((term) => <th key={term.id} colSpan={3} className="tc-term-start" scope="colgroup">{term.label}</th>)}
            <th colSpan={3} className="tc-term-start" scope="colgroup">Year</th>
            <th rowSpan={2} scope="col" className="tc-notes">Next block</th>
          </tr>
          <tr>
            {terms.map((term) => ["Days", "Points", "Balance"].map((label, index) => <th key={`${term.id}-${label}`} scope="col" className={`tc-sub${index === 0 ? " tc-term-start" : ""}`}>{label}</th>))}
            {["Points", "Expected", "Balance"].map((label, index) => <th key={label} scope="col" className={`tc-sub${index === 0 ? " tc-term-start" : ""}`}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {households.map((household) => <HouseholdPoints key={household.id} household={household} terms={terms} open={open.has(household.id)}
            onToggle={() => toggle(household.id)} people={people.filter((person) => person.household_id === household.id)} assistPoints={s.assist_points} />)}
          {people.some((person) => !person.household_id) && <>
            <tr className="tc-household-row"><th colSpan={columnCount} scope="rowgroup">Not in a household <small>Points only; no expectation</small></th></tr>
            {people.filter((person) => !person.household_id).map((person) => <tr key={person.key}>
              <th scope="row" className="tc-name">{person.name}</th>
              {terms.map((term) => { const row = person.terms.find((entry) => entry.term_id === term.id); return [
                <td key={`${term.id}-d`} className="tc-num tc-term-start">{row?.days_present ?? ""}</td>,
                <td key={`${term.id}-p`} className="tc-num">{row?.earned ?? 0}</td>, <td key={`${term.id}-b`} />]; })}
              <td className="tc-num tc-term-start tc-strong">{person.earned}</td><td /><td />
              <td className="tc-notes">{person.covers_given ? `Covered ${person.covers_given} shift${person.covers_given === 1 ? "" : "s"}` : ""}</td>
            </tr>)}
          </>}
          {!households.length && <tr><td colSpan={columnCount} className="portal-empty">No households this year.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="report-actions">
      <button type="button" disabled={busy} onClick={() => void exportAs("pdf")}>Download PDF</button>
      <button type="button" className="ghost" onClick={() => void exportAs("csv")}>Export CSV</button>
      {status && <p className="admin-form-status" role="status">{status}</p>}
    </div>
    <PointsSettings data={data} onSaved={reload} />
  </>;
}

function HouseholdPoints({ household, terms, people, open, onToggle, assistPoints }: {
  household: PointsHousehold; terms: NonNullable<DaysData["terms"]>; people: NonNullable<DaysData["people"]>;
  open: boolean; onToggle: () => void; assistPoints: number;
}) {
  const byTerm = new Map((household.terms ?? []).map((term) => [term.term_id, term]));
  return <>
    <tr className={household.balance < 0 ? "tc-behind" : ""}>
      <th scope="row" className="tc-name">
        <button type="button" className="tc-person" aria-expanded={open} onClick={onToggle}>
          <b>{open ? "▾" : "▸"} {household.name}</b><small>{people.length} adult{people.length === 1 ? "" : "s"}</small>
        </button>
      </th>
      {terms.map((term) => {
        const row = byTerm.get(term.id);
        return [
          <td key={`${term.id}-d`} className="tc-num tc-term-start" title={row?.days_away ? `${row.days_away} day${row.days_away === 1 ? "" : "s"} not there` : undefined}>{row?.days_attended ?? 0}</td>,
          <td key={`${term.id}-p`} className="tc-num">{row?.earned ?? 0}</td>,
          <td key={`${term.id}-b`} className={`tc-num${(row?.balance ?? 0) < 0 ? " tc-short" : ""}`}>{row?.balance ?? 0}</td>,
        ];
      })}
      <td className="tc-num tc-term-start tc-strong">{household.earned}</td>
      <td className="tc-num">{household.expected}</td>
      <td className={`tc-num tc-strong${household.balance < 0 ? " tc-short" : ""}`}>{household.balance}</td>
      <td className="tc-notes">{balanceText(household.balance, assistPoints)}</td>
    </tr>
    {open && people.map((person) => <tr key={person.key} className="tc-subrow">
      <th scope="row" className="tc-name"><span className="tc-indent">{person.name}</span></th>
      {terms.map((term) => { const row = person.terms.find((entry) => entry.term_id === term.id); return [
        <td key={`${term.id}-d`} className="tc-num tc-term-start">{row?.days_present ?? ""}</td>,
        <td key={`${term.id}-p`} className="tc-num">{row?.earned ?? 0}</td>, <td key={`${term.id}-b`} />]; })}
      <td className="tc-num tc-term-start">{person.earned}</td><td /><td />
      <td className="tc-notes">{[
        person.days_absent ? `out ${person.days_absent} day${person.days_absent === 1 ? "" : "s"}` : "",
        person.covers_given ? `covered ${person.covers_given} shift${person.covers_given === 1 ? "" : "s"}` : "",
        person.no_shows ? `${person.no_shows} shift${person.no_shows === 1 ? "" : "s"} covered without notice` : "",
      ].filter(Boolean).join("; ")}</td>
    </tr>)}
  </>;
}

function PointsSettings({ data, onSaved }: { data: DaysData; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [teach, setTeach] = useState(String(data.settings.teach_points));
  const [assist, setAssist] = useState(String(data.settings.assist_points));
  const [hall, setHall] = useState(String(data.settings.hall_points));
  const [message, setMessage] = useState("");
  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_save_commitment_points", { p_teach: Number(teach), p_assist: Number(assist), p_hall: Number(hall) });
    if (error) { setMessage(error.message); return; }
    setMessage("Saved.");
    await onSaved();
  }
  return <div className={`record${open ? " open" : ""}`}>
    <button type="button" className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary">Points per role</span>
      <span className="record-meta">Teach {data.settings.teach_points}, assist {data.settings.assist_points}, hall monitor {data.settings.hall_points}</span>
    </button>
    {open && <div className="record-body"><div className="portal-form tc-settings">
      <label><span className="field-caption">Teaching a class</span><input type="number" min={0} max={10} value={teach} onChange={(event) => setTeach(event.target.value)} /></label>
      <label><span className="field-caption">Assisting a class</span><input type="number" min={0} max={10} value={assist} onChange={(event) => setAssist(event.target.value)} /></label>
      <label><span className="field-caption">Hall monitor for a period</span><input type="number" min={0} max={10} value={hall} onChange={(event) => setHall(event.target.value)} /></label>
      <div className="row-actions"><button type="button" onClick={() => void save()}>Save points</button></div>
      {message && <p className="admin-form-status" role="status">{message}</p>}
    </div></div>}
  </div>;
}

// --- Co-op days ------------------------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function DaysView({ yearId }: { yearId: string | null }) {
  const { data, problem, reload } = useDaysData(yearId);
  const [termId, setTermId] = useState("");
  const [weekday, setWeekday] = useState("5");
  const [newDay, setNewDay] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);

  if (problem && !data) return <p className="admin-form-status" role="alert">{problem}</p>;
  if (!data) return <p className="portal-empty" role="status">Loading the co-op days…</p>;
  const terms = data.terms ?? [];
  const term = terms.find((entry) => entry.id === termId)
    ?? terms.find((entry) => entry.starts_on <= data.today && entry.ends_on >= data.today) ?? terms[0];
  if (!term) return <p className="portal-empty">This school year has no terms yet.</p>;
  const days = (data.days ?? []).filter((day) => day.term_id === term.id);
  const selected = (data.days ?? []).find((day) => day.id === openDay) ?? null;

  async function call(name: string, args: Record<string, unknown>, done: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { data: result, error } = await supabase.rpc(name, args);
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage(typeof result === "number" ? done.replace("#", String(result)) : done);
    await reload();
  }

  return <>
    <p className="field-note">
      The dates the co-op meets. On each one, everyone&rsquo;s class and hall monitor assignments are assumed to happen. Families
      say when they can&rsquo;t come (Family, Co-op days); their shifts are then open for others to take. Cancel a date for a
      holiday: it then counts for no one.
    </p>
    <div className="tc-controls">
      <label><span className="field-caption">Term</span>
        <select value={term.id} onChange={(event) => setTermId(event.target.value)}>
          {terms.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} ({entry.day_count} day{entry.day_count === 1 ? "" : "s"})</option>)}
        </select>
      </label>
      <label><span className="field-caption">Weekday</span>
        <select value={weekday} onChange={(event) => setWeekday(event.target.value)}>
          {WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={() => void call("admin_generate_coop_days", { p_term_id: term.id, p_weekday: Number(weekday) }, "Added # dates.")}>
        Add every {WEEKDAYS[Number(weekday)]} in {term.label}
      </button>
      <label><span className="field-caption">Add one date</span><input type="date" value={newDay} min={term.starts_on} max={term.ends_on} onChange={(event) => setNewDay(event.target.value)} /></label>
      <button type="button" className="ghost" disabled={busy || !newDay} onClick={() => void call("admin_set_coop_day", { p_term_id: term.id, p_day: newDay, p_action: "add", p_note: null }, "Added.")}>Add</button>
    </div>
    {message && <p className="admin-form-status" role="status">{message}</p>}
    {!days.length && <p className="portal-empty">No co-op days in {term.label} yet. Until there are, the term counts as one day in the points.</p>}
    {days.length > 0 && <div className="tc-scroller" role="region" aria-label={`Co-op days in ${term.label}`}>
      <table className="tc-table tc-days">
        <thead><tr><th className="tc-name" scope="col">Date</th><th scope="col">Out</th><th scope="col">Covered</th><th scope="col">Still open</th><th scope="col" className="tc-notes">Actions</th></tr></thead>
        <tbody>
          {days.map((day) => {
            const covered = day.shifts.filter((shift) => shift.cover_id).length;
            return <tr key={day.id} className={day.cancelled ? "tc-cancelled" : ""}>
              <th scope="row" className="tc-name">
                <button type="button" className="tc-person" onClick={() => setOpenDay(day.id)}>
                  <b>{dayLabel(day.day)}</b><small>{day.cancelled ? `Cancelled${day.note ? `: ${day.note}` : ""}` : day.day > data.today ? "Coming up" : day.note ?? ""}</small>
                </button>
              </th>
              <td className="tc-notes">{day.absences.map((absence) => absence.family_id ? `${absence.name} household` : absence.name).join(", ")}</td>
              <td className="tc-num">{covered || ""}</td>
              <td className={`tc-num${day.open_count ? " tc-short" : ""}`}>{day.cancelled ? "" : day.open_count}</td>
              <td className="tc-notes">
                <div className="row-actions">
                  <button type="button" className="ghost" onClick={() => setOpenDay(day.id)}>Open</button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => {
                    if (day.cancelled) { void call("admin_set_coop_day", { p_term_id: term.id, p_day: day.day, p_action: "restore", p_note: null }, "Restored."); return; }
                    const note = window.prompt("Why is there no co-op that day? (optional, e.g. Thanksgiving)") ?? undefined;
                    if (note === undefined) return;
                    void call("admin_set_coop_day", { p_term_id: term.id, p_day: day.day, p_action: "cancel", p_note: note }, "Cancelled.");
                  }}>{day.cancelled ? "Restore" : "Cancel"}</button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => void call("admin_set_coop_day", { p_term_id: term.id, p_day: day.day, p_action: "remove", p_note: null }, "Removed.")}>Remove</button>
                </div>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {selected && <DayPanel data={data} day={selected} onClose={() => setOpenDay(null)} onChanged={reload} />}
  </>;
}

function DayPanel({ data, day, onClose, onChanged }: { data: DaysData; day: CoopDay; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const [who, setWho] = useState("");
  const [reason, setReason] = useState("");
  const [coverBy, setCoverBy] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const members = data.members ?? [];
  const families = data.families ?? [];

  async function call(name: string, args: Record<string, unknown>) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return false;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc(name, args);
    setBusy(false);
    if (error) { setMessage(error.message); return false; }
    await onChanged();
    return true;
  }

  const key = (shift: CoopDay["shifts"][number]) => `${shift.user_id}-${shift.role}-${shift.class_id ?? shift.block_id}`;
  return <DetailModal title={`${dayLabel(day.day)}${day.cancelled ? " (cancelled)" : ""}`} onClose={onClose}>
    <p className="card-kicker">Not coming</p>
    <ul className="tc-history">
      {day.absences.map((absence) => <li key={absence.id}>
        <div><b>{absence.family_id ? `The ${absence.name} household` : absence.name}</b>{absence.reason && <small>{absence.reason}</small>}</div>
        <button type="button" className="ghost" disabled={busy} onClick={() => void call("admin_set_coop_absence", {
          p_coop_day_id: day.id, p_family_id: absence.family_id, p_user_id: absence.user_id, p_absent: false, p_reason: null })}>Take back</button>
      </li>)}
      {!day.absences.length && <li><div>Everyone is expected.</div></li>}
    </ul>
    {!day.cancelled && <div className="portal-form tc-form">
      <label><span className="field-caption">Mark out</span>
        <select value={who} onChange={(event) => setWho(event.target.value)}>
          <option value="">Choose…</option>
          <optgroup label="A whole household (its children are not there)">
            {families.map((family) => <option key={family.id} value={`f:${family.id}`}>{family.name}</option>)}
          </optgroup>
          <optgroup label="One adult">
            {members.map((member) => <option key={member.user_id} value={`u:${member.user_id}`}>{member.name}{member.household_name ? ` (${member.household_name})` : ""}</option>)}
          </optgroup>
        </select>
      </label>
      <label><span className="field-caption">Reason (optional)</span><input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="row-actions"><button type="button" disabled={busy || !who} onClick={async () => {
        const ok = await call("admin_set_coop_absence", { p_coop_day_id: day.id, p_family_id: who.startsWith("f:") ? who.slice(2) : null,
          p_user_id: who.startsWith("u:") ? who.slice(2) : null, p_absent: true, p_reason: reason });
        if (ok) { setWho(""); setReason(""); }
      }}>Mark out</button></div>
    </div>}

    {!day.cancelled && <>
      <p className="card-kicker">Released and covered shifts</p>
      <ul className="tc-history">
        {day.shifts.map((shift) => <li key={key(shift)}>
          <div>
            <b>{shiftLabel(shift)}</b>
            <small>{shift.owner_name}&rsquo;s{shift.released ? "" : " (not marked out)"}{shift.cover_id ? `, covered by ${shift.covering_name}` : shift.needed ? ", still open" : ", optional (the class keeps two adults)"}</small>
          </div>
          {shift.cover_id
            ? <button type="button" className="ghost" disabled={busy} onClick={() => void call("admin_remove_coop_cover", { p_cover_id: shift.cover_id, p_reason: "Removed by an administrator" })}>Remove cover</button>
            : <div className="tc-cover-pick">
                <select aria-label={`Who covers ${shiftLabel(shift)}`} value={coverBy[key(shift)] ?? ""} onChange={(event) => setCoverBy({ ...coverBy, [key(shift)]: event.target.value })}>
                  <option value="">Covered by…</option>
                  {members.filter((member) => member.user_id !== shift.user_id).map((member) => <option key={member.user_id} value={member.user_id}>{member.name}</option>)}
                </select>
                <button type="button" disabled={busy || !coverBy[key(shift)]} onClick={() => void call("admin_record_coop_cover", {
                  p_coop_day_id: day.id, p_role: shift.role, p_class_id: shift.class_id, p_block_id: shift.block_id,
                  p_covered_user_id: shift.user_id, p_covering_user_id: coverBy[key(shift)], p_note: null })}>Record</button>
              </div>}
        </li>)}
        {!day.shifts.length && <li><div>No shifts released or covered.</div></li>}
      </ul>
      <p className="field-note">For someone who did not come without saying, mark them out here and record who covered, or the person who covered can log it themselves under Family, Co-op days for two weeks after the day. {ROLE_LABEL.taught} earns {data.settings.teach_points} points, {ROLE_LABEL.assisted.toLowerCase()} {data.settings.assist_points}.</p>
    </>}
    {message && <p className="admin-form-status" role="status">{message}</p>}
  </DetailModal>;
}
