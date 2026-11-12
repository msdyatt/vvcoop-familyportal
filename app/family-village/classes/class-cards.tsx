"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { formatDayShort } from "../../../lib/schedule";
import { usePortalAccess } from "../../../lib/use-portal-access";
import PageSkeleton from "../page-skeleton";
import MfaChallengeScreen from "../mfa-challenge";
import AppHeader from "../app-header";
import TeacherNav from "../teacher/teacher-nav";
import {
  ClassCardData, Overview, classHref, gradesLabel, isCurrent, loadOverview, openClassChat,
} from "./class-data";

export type ClassesScope = "teaching" | "family" | "both";

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

const TITLES: Record<ClassesScope, { title: string; subtitle: string }> = {
  teaching: { title: "My classes", subtitle: "The classes you teach this year." },
  family: { title: "Classes", subtitle: "Your children’s classes, dates and files." },
  both: { title: "Classes", subtitle: "Classes you teach and your children’s classes." },
};

/**
 * The classes page. A teacher's route shows the classes they teach, a family's route
 * shows their children's classes, and the two share one card so they read the same.
 */
export default function ClassesOverview({ scope }: { scope: ClassesScope }) {
  const { state: access, userId, roles, recheck } = usePortalAccess(scope === "teaching" ? "teacher" : "member");
  const head = TITLES[scope];

  if (access === "loading") return <main className="workspace-preview cls-page"><AppHeader current={scope === "teaching" ? "teacher" : "home"} roles={roles} title={head.title} subtitle={head.subtitle} /><PageSkeleton /></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">{scope === "teaching" ? "Private teacher workspace" : "Private family portal"}</p><h1>{scope === "teaching" ? "Teacher access is required." : "Please sign in."}</h1><a href="/family-village">Return to Family Village →</a></main>;

  const header = <AppHeader current={scope === "teaching" ? "teacher" : "home"} roles={roles} title={head.title} subtitle={head.subtitle} />;

  // The teacher section keeps its side links on a wide screen.
  if (scope === "teaching") return <main className="workspace-preview cls-page">
    {header}
    <section className="workspace-grid">
      <TeacherNav active="classes" />
      <div className="cls-wrap wide"><ClassesSection userId={userId} scope={scope} /></div>
    </section>
  </main>;

  return <main className="workspace-preview cls-page">
    {header}
    <div className="cls-wrap"><ClassesSection userId={userId} scope={scope} /></div>
  </main>;
}

/** The cards on their own, for a page that already has its own header (the Teacher home). */
export function ClassesSection({ userId, scope }: { userId: string; scope: ClassesScope }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;
    let cancelled = false;
    loadOverview(supabase, userId)
      .then((result) => { if (!cancelled) setOverview(result); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [userId]);

  if (failed) return <p className="cls-empty" role="alert"><b>We could not load the classes.</b>Check your connection and refresh the page.</p>;
  if (!overview) return <PageSkeleton />;

  const showTeaching = scope === "teaching" || scope === "both";
  const showFamily = scope === "family" || scope === "both";
  const teaching = split(overview.teaching, overview.currentYearId);
  const family = split(overview.family, overview.currentYearId);

  return <>
    {showTeaching && <section className="cls-group" aria-labelledby="cls-teaching">
      {scope === "both" && <h2 className="cls-section-title" id="cls-teaching">Teaching this year</h2>}
      {teaching.now.length
        ? <ul className="cls-list">{teaching.now.map((item) => <li key={item.id}><ClassCard item={item} /></li>)}</ul>
        : <p className="cls-empty"><b>No classes to show yet</b>When an administrator assigns you to a class for this school year, it appears here.</p>}
      <Earlier items={teaching.earlier} />
    </section>}

    {showFamily && <section className="cls-group" aria-labelledby="cls-family">
      {scope === "both" && <h2 className="cls-section-title" id="cls-family">Your children&rsquo;s classes</h2>}
      {family.now.length
        ? <ul className="cls-list">{family.now.map((item) => <li key={item.id}><ClassCard item={item} /></li>)}</ul>
        : <p className="cls-empty"><b>No classes yet</b>Classes appear here once your children are placed in them. <a href="/family-village/children">Your children</a></p>}
      <Earlier items={family.earlier} />
    </section>}
  </>;
}

function split(items: ClassCardData[], currentYearId: string | null) {
  return {
    now: items.filter((item) => isCurrent(item, currentYearId)),
    earlier: items.filter((item) => !isCurrent(item, currentYearId)),
  };
}

function Earlier({ items }: { items: ClassCardData[] }) {
  if (!items.length) return null;
  return <details className="cls-earlier">
    <summary>Earlier years and finished classes ({items.length})</summary>
    <ul className="cls-list">{items.map((item) => <li key={item.id}><ClassCard item={item} /></li>)}</ul>
  </details>;
}

function ClassCard({ item }: { item: ClassCardData }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const teaches = item.role !== null;
  const canChat = !!item.chatId || item.role === "lead" || item.role === "assistant";

  async function chat() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setProblem("");
    const result = await openClassChat(supabase, item.id, item.chatId);
    if ("error" in result) { setProblem(result.error); setBusy(false); return; }
    window.location.assign(result.href);
  }

  const seats = item.capacity ? ` of ${item.capacity} seats` : "";
  const teacherNames = item.teachers.map((teacher) => teacher.name).join(", ");

  return <article className="cls-card">
    <div className="cls-card-head">
      <h3 className="cls-card-title"><a href={classHref(item.id)}>{item.title}</a></h3>
      <ul className="cls-chips">
        <li className="cls-chip">{gradesLabel(item.grades)}</li>
        {item.isElective && <li className="cls-chip">Elective</li>}
        {item.role === "assistant" && <li className="cls-chip">Assisting</li>}
        {item.prepNeeded && <li className="cls-chip warm">Prep needed</li>}
      </ul>
    </div>

    <dl className="cls-facts">
      <div><dt>Meets</dt><dd>{item.weekday ? [item.weekday, item.time].filter(Boolean).join(" · ") : "Schedule to be announced"}{item.room ? ` · ${item.room}` : ""}</dd></div>
      <div><dt>Next class</dt><dd>{item.ended ? "This class has finished" : item.nextMeeting ? formatDayShort(item.nextMeeting) : "Not scheduled"}</dd></div>
      {item.nextDate && <div><dt>Up next</dt><dd>{item.nextDate.title} · {formatDayShort(item.nextDate.day)}</dd></div>}
      {teaches
        ? <div><dt>Students</dt><dd>{item.studentCount ?? 0}{seats}</dd></div>
        : <>
            <div><dt>Children</dt><dd>{item.kids.map((kid) => kid.name).join(", ")}</dd></div>
            {teacherNames && <div><dt>Teacher</dt><dd>{teacherNames}</dd></div>}
          </>}
      <div><dt>Files</dt><dd>{item.fileCount ? `${item.fileCount} ${item.fileCount === 1 ? "file" : "files"}` : "None yet"}</dd></div>
    </dl>

    <div className="cls-card-actions">
      <a className="cls-btn" href={classHref(item.id)}>Open class</a>
      <a className="cls-btn quiet" href={`${classHref(item.id)}#documents`}>Documents</a>
      {canChat && <button type="button" className="cls-btn quiet" disabled={busy} onClick={chat}>{busy ? "Opening…" : "Class chat"}</button>}
    </div>
    {problem && <p className="cls-status bad" role="status">{problem}</p>}
  </article>;
}
