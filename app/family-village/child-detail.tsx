"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import Avatar from "./avatar";
import DetailModal from "./detail-modal";
import { ChildClassList, ChildDateSections, ChildDetailsEditor, EnrollOptionsList } from "./children/child-parts";
import { loadEnrollOptions, selfEnroll, useChildren, type ChildOverview, type OpenPeriod } from "./children/use-children";
import type { EnrollOption } from "../../lib/children-view";

/**
 * One child in a pop-up, everything at once: details, classes, class dates and
 * enrollment. Families no longer use this (Today and the Children page show the
 * same things in place, with a smaller Edit pop-up); Admin, Families still does.
 * It reads through the same loader as the family screens.
 */
export default function ChildDetail({ childId, onClose }: { childId: string; onClose: () => void }) {
  const state = useChildren([childId]);
  const entry = state.children[0];

  return <DetailModal onClose={onClose}>
    {state.loading ? <p>Loading…</p> : !entry ? <p className="portal-empty">{state.error || "This child could not be found."}</p> : <>
      <p className="eyebrow">Student</p>
      <div className="child-detail-heading">
        <Avatar url={entry.avatarUrl} label={entry.child.first_name} size="lg" />
        <h2>{entry.child.first_name} {entry.child.last_name}</h2>
      </div>
      <ChildDetailsEditor child={entry.child} onSaved={state.reload} />
      <section>
        <p className="card-kicker">Classes</p>
        <ChildClassList entry={entry} />
      </section>
      <ChildDateSections entry={entry} onToggle={state.toggleCompletion} />
      {state.period && <InlineEnroll entry={entry} period={state.period} onEnrolled={state.reload} />}
    </>}
  </DetailModal>;
}

function InlineEnroll({ entry, period, onEnrolled }: { entry: ChildOverview; period: OpenPeriod; onEnrolled: () => Promise<void> }) {
  const [options, setOptions] = useState<EnrollOption[] | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    loadEnrollOptions(supabase, entry.child, period).then((list) => { if (!cancelled) setOptions(list); }, () => { if (!cancelled) setOptions([]); });
    return () => { cancelled = true; };
  // A reload after enrolling hands over a fresh child row, which loads the shorter list.
  }, [entry.child, period]);

  async function enroll() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !picks.length) return;
    setStatus("Enrolling…");
    const lines: string[] = [];
    for (const classId of picks) {
      const title = options?.find((option) => option.id === classId)?.title ?? "the class";
      const error = await selfEnroll(supabase, period.id, entry.child.id, classId);
      lines.push(error ? `${title}: ${error}` : `Enrolled in ${title}.`);
    }
    setPicks([]);
    setStatus(lines.join(" "));
    await onEnrolled();
  }

  return <section>
    <p className="card-kicker">Enrollment is open</p>
    <p className="field-note">
      {period.title} closes {new Date(period.closes_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}.
      {period.electives_only ? " Choose electives for " : " Choose classes for "}{entry.child.first_name}. Enrolling is immediate, no approval needed.
    </p>
    {options === null ? <p className="portal-empty">Loading classes…</p> : <>
      <EnrollOptionsList child={entry.child} options={options} picks={picks} onChange={setPicks} />
      {options.length > 0 && <button className="enroll-confirm" disabled={!picks.length} onClick={enroll}>Enroll {entry.child.first_name}</button>}
    </>}
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </section>;
}
