"use client";

import { FormEvent, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { ClassDate, ClassPageData, toLocalDay } from "./class-data";

function parts(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year, month - 1, date);
  return {
    month: value.toLocaleDateString("en-US", { month: "short" }),
    day: String(date),
    weekday: value.toLocaleDateString("en-US", { weekday: "long" }),
  };
}

/**
 * What the class is working on, when, where, and whether families need to do
 * something first. A date carrying "prep needed" tells a parent more than a separate
 * homework row, so there is one list. Dates are whole days: a co-op class has a day,
 * not a start time, and asking for one produced times nobody meant.
 */
export default function ClassDates({ data, userId, onChanged }: { data: ClassPageData; userId: string; onChanged: () => void }) {
  const canManage = data.isLead || data.isAdmin;
  const today = toLocalDay(new Date());
  const upcoming = data.dates.filter((item) => item.day >= today);
  const earlier = data.dates.filter((item) => item.day < today).reverse();
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const done = new Set(data.completions.map((entry) => `${entry.eventId}:${entry.childId}`));

  async function remove(item: ClassDate) {
    if (!confirm(`Remove "${item.title}"? Families will no longer see it.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: removed, error } = await supabase.from("events").delete().eq("id", item.id).select("id");
    if (error || !removed?.length) { setStatus(error?.message ?? "Only a lead teacher can remove class dates."); return; }
    setStatus(`Removed "${item.title}".`);
    onChanged();
  }

  async function mark(eventId: string, childIds: string[], ready: boolean) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !childIds.length) return;
    const result = ready
      ? await supabase.from("event_completions").upsert(childIds.map((childId) => ({ event_id: eventId, child_id: childId, completed_by: userId })), { onConflict: "event_id,child_id" })
      : await supabase.from("event_completions").delete().eq("event_id", eventId).in("child_id", childIds);
    if (result.error) { setStatus(result.error.message); return; }
    onChanged();
  }

  function row(item: ClassDate) {
    const when = parts(item.day);
    const childIds = data.kids.map((kid) => kid.id);
    const allReady = childIds.length > 0 && childIds.every((id) => done.has(`${item.id}:${id}`));
    return <li key={item.id} className="cls-row">
      <div className="cls-datebox" aria-hidden="true"><span>{when.month}</span><b>{when.day}</b></div>
      <div className="cls-row-main">
        <span className="cls-row-title">{item.title}</span>
        <span className="cls-row-sub">{[when.weekday, item.location].filter(Boolean).join(" · ")}</span>
        {item.description && <span className="cls-row-sub" style={{ whiteSpace: "pre-wrap" }}>{item.description}</span>}
        {item.requiresPrework && <span>
          <span className="cls-chip warm">Prep needed</span>
          {data.kids.length > 0 && <span className="cls-date-prep">
            {data.kids.map((kid) => {
              const ready = done.has(`${item.id}:${kid.id}`);
              return <label key={kid.id} className="cls-check">
                <input type="checkbox" checked={ready} onChange={() => mark(item.id, [kid.id], !ready)} />
                {kid.name} {ready ? "is ready" : "has prep to do"}
              </label>;
            })}
            {data.kids.length > 1 && <button type="button" className="cls-btn quiet small" onClick={() => mark(item.id, childIds, !allReady)}>{allReady ? "Clear all" : "Mark all ready"}</button>}
          </span>}
        </span>}
      </div>
      {canManage && <div className="cls-row-actions"><button type="button" className="cls-btn remove small" onClick={() => remove(item)} aria-label={`Remove ${item.title}`}>Remove</button></div>}
    </li>;
  }

  return <>
    <div className="cls-panel-head">
      <h3 className="cls-section-title">Class dates</h3>
      {canManage && !adding && <button type="button" className="cls-btn small" onClick={() => setAdding(true)}>Add a date</button>}
    </div>
    <p className="cls-note">Only this class&rsquo;s teachers and enrolled families see these. They are not on the co-op calendar.</p>

    {canManage && adding && <AddDate klassId={data.klass.id} onClose={() => setAdding(false)} onAdded={(message) => { setStatus(message); onChanged(); }} />}
    {!canManage && data.isAssistant && <p className="cls-note">The lead teacher sets class dates.</p>}

    {upcoming.length
      ? <ul className="cls-rows">{upcoming.map(row)}</ul>
      : <p className="cls-note">{canManage ? "Nothing scheduled yet. Add what the class is working on and when." : "Nothing is scheduled for this class yet."}</p>}

    {earlier.length > 0 && <details>
      <summary className="cls-subhead" style={{ cursor: "pointer" }}>Earlier dates ({earlier.length})</summary>
      <ul className="cls-rows">{earlier.map(row)}</ul>
    </details>}

    <p className="cls-status" role="status">{status}</p>
  </>;
}

function AddDate({ klassId, onClose, onAdded }: { klassId: string; onClose: () => void; onAdded: (message: string) => void }) {
  const [title, setTitle] = useState("");
  const [on, setOn] = useState("");
  const [location, setLocation] = useState("");
  const [instructions, setInstructions] = useState("");
  const [requiresPrework, setRequiresPrework] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !on) return;
    setBusy(true); setProblem("");
    const { error } = await supabase.from("events").insert({
      class_id: klassId,
      audience: "class",
      title: title.trim(),
      description: instructions.trim() || null,
      // Stored at midday UTC so the date cannot slide either side of midnight
      // when it is read back in Central Time.
      starts_at: new Date(`${on}T12:00:00Z`).toISOString(),
      location: location.trim() || null,
      requires_prework: requiresPrework,
    });
    setBusy(false);
    if (error) { setProblem(error.message); return; }
    onAdded("Added. Families in this class can see it now.");
    onClose();
  }

  return <form className="cls-form" onSubmit={submit}>
    <label className="cls-field"><span>What is the class working on?</span>
      <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Rock layers and fossils" disabled={busy} />
    </label>
    <div className="cls-field-row">
      <label className="cls-field"><span>Date</span>
        <input required type="date" value={on} onChange={(event) => setOn(event.target.value)} disabled={busy} />
      </label>
      <label className="cls-field"><span>Where <i>optional</i></span>
        <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Room 2" disabled={busy} />
      </label>
    </div>
    <label className="cls-field"><span>Notes for families <i>optional</i></span>
      <textarea rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="What to bring, or what to read first" disabled={busy} />
    </label>
    <label className="cls-check">
      <input type="checkbox" checked={requiresPrework} onChange={(event) => setRequiresPrework(event.target.checked)} disabled={busy} />
      Families need to do something before this class
    </label>
    <div className="cls-actions">
      <button className="cls-btn" disabled={busy || !title.trim() || !on}>{busy ? "Saving…" : "Add date"}</button>
      <button type="button" className="cls-btn quiet" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
    {problem && <p className="cls-status bad" role="alert">{problem}</p>}
  </form>;
}
