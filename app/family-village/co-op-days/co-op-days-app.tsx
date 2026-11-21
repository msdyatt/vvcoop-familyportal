"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { usePortalAccess } from "../../../lib/use-portal-access";
import { dayLabel, shiftLabel, type MyCoopDay, type MyCoopDays } from "../../../lib/teaching-commitment";
import PageSkeleton from "../page-skeleton";
import AppHeader from "../app-header";
import MfaChallengeScreen from "../mfa-challenge";

/**
 * Family, Co-op days (issue #151 with #129). Every class and hall monitor assignment is assumed to happen on each co-op
 * day. Here a person says they can't make it (their shifts open up for others), or that the whole family won't be
 * there; takes a shift someone else released; and logs, up to two weeks after the day, that they covered for someone
 * who did not come. The database decides what is allowed (public.my_coop_days and the functions beside it).
 */

const TITLE = "Co-op days";
const SUBTITLE = "Your teaching and assisting shifts, days you can't make it, and shifts to cover.";

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

export default function CoopDaysApp() {
  const { state: access, roles, recheck } = usePortalAccess("member");
  const [data, setData] = useState<MyCoopDays | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: next, error: failure } = await supabase.rpc("my_coop_days");
    if (failure) { setError(failure.message); return; }
    setData(next as MyCoopDays); setError("");
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch once access resolves
  useEffect(() => { if (access === "ready") void load(); }, [access, load]);

  async function call(name: string, args: Record<string, unknown>, done: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error: failure } = await supabase.rpc(name, args);
    setBusy(false);
    if (failure) { setMessage(failure.message); return; }
    setMessage(done);
    await load();
  }

  if (access === "loading") return <main className="workspace-preview coop-days-page"><AppHeader current="home" roles={roles} title={TITLE} subtitle={SUBTITLE} /><PageSkeleton /></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><a href="/family-village">Return to sign in →</a></main>;

  const upcoming = (data?.days ?? []).filter((day) => day.day >= (data?.today ?? ""));
  const recent = (data?.days ?? []).filter((day) => day.day < (data?.today ?? "")).reverse();
  return <main className="workspace-preview coop-days-page">
    <AppHeader current="home" roles={roles} title={TITLE} subtitle={SUBTITLE} />
    <p className="field-note">
      Your classes and hall monitor periods are counted on every co-op day without you doing anything. If you can&rsquo;t
      come, say so here as early as you can: your shifts open up for someone else to take. If you covered for someone,
      take their shift here, or log it afterwards.
    </p>
    {message && <p className="admin-form-status" role="status">{message}</p>}
    {error && <p className="dues-error" role="alert">{error}</p>}
    {!data && !error && <p className="portal-empty">Loading…</p>}
    {data && !data.days.length && <p className="portal-empty">No co-op days are set up for the coming weeks yet.</p>}
    {upcoming.map((day) => <DayCard key={day.id} day={day} today={data!.today} household={data!.household?.name ?? null} busy={busy} call={call} />)}
    {recent.length > 0 && <>
      <h2 className="coop-days-heading">The last two weeks</h2>
      <p className="field-note">Covered for someone who didn&rsquo;t come? Log it here so it counts.</p>
      {recent.map((day) => <DayCard key={day.id} day={day} today={data!.today} household={data!.household?.name ?? null} busy={busy} call={call} />)}
    </>}
  </main>;
}

function DayCard({ day, today, household, busy, call }: {
  day: MyCoopDay; today: string; household: string | null; busy: boolean;
  call: (name: string, args: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [logging, setLogging] = useState("");
  const future = day.day >= today;
  const ask = (question: string) => { const answer = window.prompt(question); return answer === null ? null : answer; };

  if (day.cancelled) {
    return <section className="coop-day cancelled"><h3>{dayLabel(day.day)}</h3><p>No co-op{day.note ? `: ${day.note}` : ""}.</p></section>;
  }
  return <section className={`coop-day${day.me_absent || day.family_absent ? " out" : ""}`}>
    <header>
      <h3>{dayLabel(day.day)}{day.day === today ? " (today)" : ""}</h3>
      <small>{day.term}</small>
    </header>

    {household && <div className="coop-day-row">
      {day.family_absent
        ? <><p>The {household} household is marked as not coming.</p>
            {future && <button type="button" className="ghost" disabled={busy} onClick={() => void call("set_my_coop_day_absence", { p_coop_day_id: day.id, p_scope: "family", p_absent: false }, "Marked as coming.")}>We&rsquo;re coming after all</button>}</>
        : future && <button type="button" className="ghost" disabled={busy} onClick={() => {
            const reason = ask("Our family won't be there. Anything the co-op should know? (optional)");
            if (reason !== null) void call("set_my_coop_day_absence", { p_coop_day_id: day.id, p_scope: "family", p_absent: true, p_reason: reason }, "Your household is marked as not coming. Your shifts are open for others.");
          }}>Our family won&rsquo;t be there</button>}
    </div>}

    <p className="card-kicker">Your shifts</p>
    {day.mine.length ? <ul className="coop-shifts">
      {day.mine.map((shift) => <li key={`${shift.role}-${shift.class_id ?? shift.block_id}`}>
        <span>{shiftLabel(shift)}</span>
        <small>{shift.covering_name ? `Covered by ${shift.covering_name}` : shift.released ? "Open for someone to take" : "Counted"}</small>
      </li>)}
    </ul> : <p className="field-note">No shifts on the schedule.</p>}
    {day.mine.length > 0 && future && !day.family_absent && (day.me_absent
      ? <div className="coop-day-row"><p>You said you can&rsquo;t make it.</p>
          <button type="button" className="ghost" disabled={busy} onClick={() => void call("set_my_coop_day_absence", { p_coop_day_id: day.id, p_scope: "me", p_absent: false }, "Marked as coming.")}>I can come after all</button></div>
      : <div className="coop-day-row"><button type="button" disabled={busy} onClick={() => {
          const reason = ask("Can't make it? A reason helps whoever covers (optional).");
          if (reason !== null) void call("set_my_coop_day_absence", { p_coop_day_id: day.id, p_scope: "me", p_absent: true, p_reason: reason }, "Your shifts are open for others to take.");
        }}>I can&rsquo;t make it</button></div>)}

    {day.open.length > 0 && <>
      <p className="card-kicker">Shifts to cover</p>
      <ul className="coop-shifts">
        {day.open.map((shift) => <li key={`${shift.owner_id}-${shift.role}-${shift.class_id ?? shift.block_id}`}>
          <span>{shiftLabel(shift)}<small> for {shift.owner_name}{shift.needed ? "" : " (optional: the class still has two adults)"}</small></span>
          <button type="button" disabled={busy || day.me_absent || day.family_absent} onClick={() => void call("cover_coop_shift", {
            p_coop_day_id: day.id, p_role: shift.role, p_class_id: shift.class_id, p_block_id: shift.block_id, p_covered_user_id: shift.owner_id, p_note: null,
          }, "Thank you. The shift is yours.")}>I&rsquo;ll cover it</button>
        </li>)}
      </ul>
    </>}

    {day.my_covers.length > 0 && <>
      <p className="card-kicker">You&rsquo;re covering</p>
      <ul className="coop-shifts">
        {day.my_covers.map((cover) => <li key={cover.id}>
          <span>{shiftLabel(cover)}<small> for {cover.owner_name}</small></span>
          <button type="button" className="ghost" disabled={busy} onClick={() => void call("withdraw_coop_cover", { p_cover_id: cover.id }, "Withdrawn.")}>Withdraw</button>
        </li>)}
      </ul>
    </>}

    {day.day <= today && day.loggable.length > 0 && <div className="coop-day-row coop-log">
      <label><span className="field-caption">Covered for someone who didn&rsquo;t come?</span>
        <select value={logging} onChange={(event) => setLogging(event.target.value)}>
          <option value="">Choose the shift…</option>
          {day.loggable.map((shift, index) => <option key={index} value={String(index)}>{shiftLabel(shift)} for {shift.owner_name}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || logging === ""} onClick={() => {
        const shift = day.loggable[Number(logging)];
        void call("cover_coop_shift", { p_coop_day_id: day.id, p_role: shift.role, p_class_id: shift.class_id, p_block_id: shift.block_id,
          p_covered_user_id: shift.owner_id, p_note: null }, "Logged. Thank you for covering.").then(() => setLogging(""));
      }}>Log it</button>
    </div>}
  </section>;
}
