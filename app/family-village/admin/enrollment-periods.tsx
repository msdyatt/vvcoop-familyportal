"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { SchoolYear } from "../../../lib/compliance";

type Period = {
  id: string; title: string; opens_at: string; closes_at: string;
  active: boolean; electives_only: boolean; school_year_id: string | null;
};

function day(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function windowState(period: Period): { label: string; tone: string } {
  const now = Date.now();
  if (!period.active) return { label: "Closed", tone: "waived" };
  if (now < new Date(period.opens_at).getTime()) return { label: "Opens " + day(period.opens_at), tone: "pending" };
  if (now > new Date(period.closes_at).getTime()) return { label: "Ended " + day(period.closes_at), tone: "waived" };
  return { label: "Open now", tone: "complete" };
}

/**
 * Windows during which families may choose classes.
 *
 * The tables for this already existed — created by hand, never in a migration,
 * and referenced only by `private.enrollment_request_allowed`, which turned out
 * to be a careful piece of work: it checks the window is open, that the child
 * belongs to the requesting family, that the grade matches, and that the child
 * is not already booked into the same time block. It is wired up here rather
 * than reinvented.
 */
export default function EnrollmentPeriods({ years, currentYearId, onStatus }: {
  years: SchoolYear[];
  currentYearId: string | null;
  onStatus: (message: string) => void;
}) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [electivesOnly, setElectivesOnly] = useState(true);
  const [announce, setAnnounce] = useState(true);
  const [busy, setBusy] = useState(false);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("enrollment_periods")
      .select("id,title,opens_at,closes_at,active,electives_only,school_year_id")
      .order("opens_at", { ascending: false });
    setPeriods((data ?? []) as Period[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !opensAt || !closesAt) return;
    if (new Date(closesAt) <= new Date(opensAt)) { onStatus("The window has to close after it opens."); return; }
    setBusy(true);

    const { error } = await supabase.from("enrollment_periods").insert({
      title: title.trim(),
      opens_at: new Date(`${opensAt}T00:00:00Z`).toISOString(),
      closes_at: new Date(`${closesAt}T23:59:59Z`).toISOString(),
      active: true,
      electives_only: electivesOnly,
      school_year_id: currentYearId,
    });

    if (error) { setBusy(false); onStatus(error.message); return; }

    // A window nobody hears about is a window nobody uses, so opening one
    // announces itself rather than relying on someone remembering to post.
    if (announce) {
      const { data: user } = await supabase.auth.getUser();
      const { error: postError } = await supabase.from("posts").insert({
        author_user_id: user.user?.id,
        title: `${title.trim()} is open`,
        body: `${electivesOnly ? "Elective sign-ups are" : "Enrollment is"} open from ${day(opensAt)} to ${day(closesAt)}. `
          + `Choose classes for your children in Family Village before the window closes.`,
        audience: "families",
        published_at: new Date().toISOString(),
      });
      if (postError) {
        setBusy(false);
        onStatus(`Window created, but the announcement could not be posted: ${postError.message}`);
        await load();
        return;
      }
    }

    setBusy(false);
    setTitle(""); setOpensAt(""); setClosesAt(""); setAdding(false);
    onStatus(announce ? "Enrollment window opened and announced to families." : "Enrollment window opened.");
    await load();
  }

  async function toggleActive(period: Period) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("enrollment_periods").update({ active: !period.active }).eq("id", period.id);
    if (error) { onStatus(error.message); return; }
    onStatus(`${period.title} is now ${period.active ? "closed" : "open"}.`);
    await load();
  }

  const live = periods.filter((period) => windowState(period).label === "Open now").length;

  return <div className="record-section school-years">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Enrollment windows</b></span>
      <span className="record-meta">{live ? `${live} open now` : `${periods.length} configured`}</span>
    </button>

    {open && <div className="record-body">
      <p className="field-note">
        While a window is open, families can choose classes for their children. Elective-only windows leave core
        classes to be placed by an administrator.
      </p>

      {periods.map((period) => {
        const state = windowState(period);
        return <div className="child-line" key={period.id}>
          <b>{period.title}</b>
          <span>
            {day(period.opens_at)} – {day(period.closes_at)}
            {period.electives_only ? " · electives only" : " · all classes"}
            {period.school_year_id ? ` · ${years.find((year) => year.id === period.school_year_id)?.label ?? ""}` : ""}
          </span>
          <div className="row-actions">
            <span className={`status-pill ${state.tone}`}>{state.label}</span>
            <button onClick={() => toggleActive(period)}>{period.active ? "Close" : "Reopen"}</button>
          </div>
        </div>;
      })}
      {!periods.length && <p className="portal-empty">No enrollment windows yet.</p>}

      {!adding
        ? <button className="add-child-button" onClick={() => setAdding(true)}>Open an enrollment window</button>
        : <form onSubmit={submit} className="portal-form">
            <label><span className="field-caption">Name</span>
              <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Spring elective sign-ups" disabled={busy} />
            </label>
            <label><span className="field-caption">Opens</span>
              <input required type="date" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} disabled={busy} />
            </label>
            <label><span className="field-caption">Closes</span>
              <input required type="date" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} disabled={busy} />
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={electivesOnly} onChange={(event) => setElectivesOnly(event.target.checked)} />
              Electives only
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={announce} onChange={(event) => setAnnounce(event.target.checked)} />
              Announce this in Village news
            </label>
            <div className="row-actions">
              <button disabled={busy}>{busy ? "Opening…" : "Open window"}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>}
    </div>}
  </div>;
}
