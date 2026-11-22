"use client";

import { useEffect, useRef, useState } from "react";
import DetailModal from "../detail-modal";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import type { EnrollOption } from "../../../lib/children-view";
import { EnrollOptionsList } from "./child-parts";
import { loadEnrollOptions, selfEnroll, type ChildOverview, type OpenPeriod } from "./use-children";

type Result = { childName: string; classTitle: string; error: string };

/**
 * Enrollment as its own short step: pick classes for each child in turn, check
 * the list, then enroll. Nothing is saved until Enroll on the last screen.
 */
export default function EnrollFlow({ entries, period, firstChildId, onClose, onEnrolled }: {
  entries: ChildOverview[];
  period: OpenPeriod;
  firstChildId?: string | null;
  onClose: () => void;
  onEnrolled: () => Promise<void> | void;
}) {
  // The child whose Enroll button was pressed comes first.
  const ordered = [...entries].sort((a, b) => Number(b.child.id === firstChildId) - Number(a.child.id === firstChildId));
  const [options, setOptions] = useState<Record<string, EnrollOption[]> | null>(null);
  const [loadError, setLoadError] = useState("");
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const reviewStep = ordered.length;
  const top = useRef<HTMLDivElement>(null);

  // Each step starts at the top of the pop-up, not wherever the last list was scrolled to.
  useEffect(() => { top.current?.closest("dialog")?.scrollTo(0, 0); }, [step, results]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      try {
        const lists = await Promise.all(ordered.map((entry) => loadEnrollOptions(supabase, entry.child, period)));
        if (!cancelled) setOptions(Object.fromEntries(ordered.map((entry, index) => [entry.child.id, lists[index]])));
      } catch {
        if (!cancelled) setLoadError("Could not load the classes. Close this and try again.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when the step opens
  }, []);

  const titleOf = (childId: string, classId: string) => options?.[childId]?.find((option) => option.id === classId)?.title ?? "a class";
  const whenOf = (childId: string, classId: string) => options?.[childId]?.find((option) => option.id === classId)?.when ?? "";
  const pickCount = Object.values(picks).reduce((sum, list) => sum + list.length, 0);
  const closes = new Date(period.closes_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  async function enroll() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const done: Result[] = [];
    for (const entry of ordered) {
      for (const classId of picks[entry.child.id] ?? []) {
        const error = await selfEnroll(supabase, period.id, entry.child.id, classId);
        done.push({ childName: entry.child.first_name, classTitle: titleOf(entry.child.id, classId), error });
      }
    }
    setResults(done);
    setBusy(false);
    await onEnrolled();
  }

  let body;
  if (results) {
    body = <>
      <ul className="enroll-results">{results.map((row, index) => <li key={index} className={row.error ? "failed" : "ok"}>
        {row.error ? `Could not enroll ${row.childName} in ${row.classTitle}: ${row.error}` : `${row.childName} is enrolled in ${row.classTitle}.`}
      </li>)}</ul>
      <div className="enroll-steps-actions"><button type="button" className="enroll-confirm" onClick={onClose}>Done</button></div>
    </>;
  } else if (loadError) {
    body = <p className="portal-empty" role="status">{loadError}</p>;
  } else if (!options) {
    body = <p className="portal-empty">Loading classes…</p>;
  } else if (step < reviewStep) {
    const entry = ordered[step];
    const list = options[entry.child.id] ?? [];
    body = <>
      <p className="enroll-step-count">{ordered.length > 1 ? `Step ${step + 1} of ${ordered.length + 1}` : "Step 1 of 2"}</p>
      <h3>Choose {period.electives_only ? "electives" : "classes"} for {entry.child.first_name}</h3>
      {list.length > 0 && <p className="field-note">Pick one class for each time. You can skip a child and come back later.</p>}
      <EnrollOptionsList child={entry.child} options={list} picks={picks[entry.child.id] ?? []}
        onChange={(next) => setPicks((current) => ({ ...current, [entry.child.id]: next }))} />
      <div className="enroll-steps-actions">
        {step > 0 && <button type="button" className="ghost" onClick={() => setStep(step - 1)}>Back</button>}
        <button type="button" className="enroll-confirm" onClick={() => setStep(step + 1)}>
          {step + 1 < reviewStep ? `Next: ${ordered[step + 1].child.first_name}` : "Review"}
        </button>
      </div>
    </>;
  } else {
    body = <>
      <p className="enroll-step-count">Step {ordered.length + 1} of {ordered.length + 1}</p>
      <h3>Check and enroll</h3>
      <ul className="enroll-review">{ordered.map((entry) => {
        const mine = picks[entry.child.id] ?? [];
        return <li key={entry.child.id}>
          <b>{entry.child.first_name}</b>
          {mine.length
            ? <ul>{mine.map((classId) => <li key={classId}>{titleOf(entry.child.id, classId)}<small>{whenOf(entry.child.id, classId)}</small></li>)}</ul>
            : <span>Nothing picked</span>}
        </li>;
      })}</ul>
      <p className="field-note">Enrolling is immediate. No approval is needed.</p>
      <div className="enroll-steps-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => setStep(step - 1)}>Back</button>
        <button type="button" className="enroll-confirm" disabled={busy || !pickCount} onClick={enroll}>
          {busy ? "Enrolling…" : pickCount === 1 ? "Enroll in 1 class" : `Enroll in ${pickCount} classes`}
        </button>
      </div>
    </>;
  }

  return <DetailModal title={`Enroll: ${period.title}`} onClose={onClose}>
    <div className="enroll-flow" ref={top}>
      <p className="field-note">Closes {closes}.</p>
      {body}
    </div>
  </DetailModal>;
}
