"use client";

import { KeyboardEvent, useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { formatDayShort } from "../../../lib/schedule";
import { usePortalAccess } from "../../../lib/use-portal-access";
import PageSkeleton from "../page-skeleton";
import MfaChallengeScreen from "../mfa-challenge";
import AppHeader from "../app-header";
import { ClassPageData, gradesLabel, loadClassPage, openClassChat } from "./class-data";
import ClassDocuments from "./class-documents";
import ClassDates from "./class-dates";
import ClassPeople from "./class-people";

type Tab = "documents" | "dates" | "people";
const TABS: { id: Tab; label: string }[] = [
  { id: "documents", label: "Documents" },
  { id: "dates", label: "Dates" },
  { id: "people", label: "People" },
];

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

function tabFromHash(): Tab {
  if (typeof window === "undefined") return "documents";
  const wanted = window.location.hash.replace("#", "");
  return TABS.some((tab) => tab.id === wanted) ? (wanted as Tab) : "documents";
}

/**
 * One class, for everyone connected to it.
 *
 * Teachers and the parents of enrolled children open the same page and see what
 * their relationship to the class allows: the teaching team sees the roster and the
 * teacher-only curriculum files, the lead teachers can add and remove files and
 * dates, and a parent sees their own children, the teachers, the family handouts
 * and the class dates. A person with no link to the class is shown nothing.
 */
export default function ClassPage() {
  const { state: access, userId, roles, recheck } = usePortalAccess("member");
  const [classId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("id"));
  /** undefined while loading, null when there is nothing this person may see. */
  const [data, setData] = useState<ClassPageData | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [failed, setFailed] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatProblem, setChatProblem] = useState("");

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId || !classId) return;
    try { setData(await loadClassPage(supabase, userId, classId, roles)); } catch { setFailed(true); }
  }, [userId, classId, roles]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch once access resolves
  useEffect(() => { if (access === "ready") load(); }, [access, load]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function choose(next: Tab) {
    setTab(next);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${next}`);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    choose(next.id);
    document.getElementById(`cls-tab-${next.id}`)?.focus();
  }

  const onTeam = !!data && (data.isLead || data.isAssistant || data.isAdmin);
  const current = onTeam && (data.isLead || data.isAssistant) ? "teacher" : "home";
  const back = onTeam ? { href: "/family-village/teacher/classes", label: "My classes" } : { href: "/family-village/classes", label: "Classes" };

  if (access === "loading") return <main className="workspace-preview cls-page"><AppHeader current="home" roles={roles} title="Class" /><PageSkeleton /></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><a href="/family-village">Return to sign in →</a></main>;

  if (!classId || data === null || failed) {
    return <main className="workspace-preview cls-page">
      <AppHeader current="home" roles={roles} title="Class" />
      <div className="cls-wrap">
        <a className="cls-back" href="/family-village/classes">← Classes</a>
        <p className="cls-empty" role={failed ? "alert" : undefined}>
          <b>{failed ? "We could not load this class." : "This class is not available to you."}</b>
          {failed ? "Check your connection and try again." : "Classes are shown to their teachers and to the families of enrolled children."}
        </p>
      </div>
    </main>;
  }
  if (!data) return <main className="workspace-preview cls-page"><AppHeader current="home" roles={roles} title="Class" /><PageSkeleton /></main>;

  const { klass } = data;
  const canStartChat = onTeam;

  async function chat() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !data) return;
    setChatBusy(true); setChatProblem("");
    const result = await openClassChat(supabase, klass.id, data.chatId);
    if ("error" in result) { setChatProblem(result.error); setChatBusy(false); return; }
    window.location.assign(result.href);
  }

  const counts: Record<Tab, number | null> = {
    documents: data.documents.length,
    dates: data.dates.filter((item) => item.day >= todayDay()).length,
    people: onTeam ? data.roster.length : null,
  };

  return <main className="workspace-preview cls-page">
    <AppHeader current={current} roles={roles} title="Class" subtitle={klass.title} />
    <div className="cls-wrap">
      <a className="cls-back" href={back.href}>← {back.label}</a>

      <section className="cls-hero" aria-label="About this class">
        <div>
          <h2>{klass.title}</h2>
          <ul className="cls-chips" style={{ marginTop: 10 }}>
            <li className="cls-chip">{gradesLabel(klass.grades)}</li>
            {klass.isElective && <li className="cls-chip">Elective</li>}
            {data.isAssistant && !data.isLead && <li className="cls-chip">You assist</li>}
            {data.isLead && <li className="cls-chip">You lead this class</li>}
          </ul>
        </div>
        <dl className="cls-facts">
          <div><dt>Meets</dt><dd>{klass.weekday ? [klass.weekday, klass.time].filter(Boolean).join(" · ") : "Schedule to be announced"}</dd></div>
          {klass.room && <div><dt>Room</dt><dd>{klass.room}</dd></div>}
          <div><dt>Next class</dt><dd>{klass.ended ? "This class has finished" : klass.nextMeeting ? formatDayShort(klass.nextMeeting) : "Not scheduled"}</dd></div>
          <div><dt>{data.teachers.length === 1 ? "Teacher" : "Teachers"}</dt><dd>{data.teachers.length ? data.teachers.map((teacher) => teacher.name).join(", ") : "To be announced"}</dd></div>
          {!onTeam && data.kids.length > 0 && <div><dt>Enrolled</dt><dd>{data.kids.map((kid) => kid.name).join(", ")}</dd></div>}
        </dl>
        {klass.description && <p className="cls-description">{klass.description}</p>}
        {(data.chatId || canStartChat) && <div className="cls-actions">
          <button type="button" className="cls-btn quiet" disabled={chatBusy} onClick={chat}>
            {chatBusy ? "Opening…" : data.chatId ? "Open class chat" : "Start class chat"}
          </button>
        </div>}
        {chatProblem && <p className="cls-status bad" role="status">{chatProblem}</p>}
      </section>

      <div className="cls-tabs" role="tablist" aria-label="Class sections">
        {TABS.map((item, index) => <button key={item.id} type="button" role="tab" className="cls-tab" id={`cls-tab-${item.id}`}
          aria-selected={tab === item.id} aria-controls={`cls-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => choose(item.id)} onKeyDown={(event) => onTabKey(event, index)}>
          {item.label}{counts[item.id] ? <span className="cls-tab-count">{counts[item.id]}</span> : null}
        </button>)}
      </div>

      <div role="tabpanel" id={`cls-panel-${tab}`} aria-labelledby={`cls-tab-${tab}`} className="cls-panel">
        {tab === "documents" && <ClassDocuments data={data} userId={userId} onChanged={load} />}
        {tab === "dates" && <ClassDates data={data} userId={userId} onChanged={load} />}
        {tab === "people" && <ClassPeople data={data} />}
      </div>
    </div>
  </main>;
}

function todayDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
