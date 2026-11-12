"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrls } from "../../../lib/storage";
import Avatar from "../avatar";
import { ClassPageData, Kid, Teacher, openChildThread } from "./class-data";

/**
 * Who is in the class.
 *
 * The teaching team sees every enrolled student, each with a "Message parents"
 * button that opens the private thread between the teacher and that student's
 * parents. A parent sees the teachers and their own children, with a "Message
 * <teacher>" button that opens the same thread from the other side. No parent is
 * ever shown another family's child; the query comes back with only their own.
 */
export default function ClassPeople({ data }: { data: ClassPageData }) {
  const onTeam = data.isLead || data.isAssistant || data.isAdmin;
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");

  const avatarPaths = onTeam ? data.roster.map((person) => person.avatarPath).filter((path): path is string => !!path) : [];
  const avatarKey = avatarPaths.join("|");
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !avatarKey) return;
    let cancelled = false;
    getSignedFileUrls(supabase, avatarKey.split("|")).then((urls) => { if (!cancelled) setAvatarUrls(urls); });
    return () => { cancelled = true; };
  }, [avatarKey]);

  async function open(key: string, childId: string, teacherId?: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(key); setProblem("");
    const result = await openChildThread(supabase, childId, teacherId);
    if ("error" in result) { setProblem(result.error); setBusy(null); return; }
    window.location.assign(result.href);
  }

  return <>
    <section aria-label="Teachers">
      <h3 className="cls-section-title">{data.teachers.length === 1 ? "Teacher" : "Teachers"}</h3>
      {data.teachers.length
        ? <ul className="cls-rows">{data.teachers.map((teacher) => <li key={teacher.id} className="cls-row cls-person">
            <div className="cls-row-main">
              <span className="cls-row-title">{teacher.name}</span>
              <span className="cls-row-sub">{teacher.role === "lead" ? "Lead teacher" : "Assistant"}</span>
            </div>
            {!onTeam && data.kids.length > 0 && <div className="cls-person-actions">
              <MessageTeacher teacher={teacher} kids={data.kids} busy={busy} onOpen={open} />
            </div>}
          </li>)}</ul>
        : <p className="cls-note">No teacher has been assigned to this class yet.</p>}
    </section>

    {onTeam
      ? <section aria-label="Students">
          <h3 className="cls-section-title">Students ({data.roster.length}{data.klass.capacity ? ` of ${data.klass.capacity} seats` : ""})</h3>
          {data.roster.length
            ? <ul className="cls-rows">{data.roster.map((person) => <li key={person.id} className="cls-row cls-person">
                <Avatar url={person.avatarPath ? avatarUrls.get(person.avatarPath) ?? null : null} label={person.name} size="sm" />
                <div className="cls-row-main">
                  <span className="cls-row-title">{person.name}</span>
                  {person.grade && <span className="cls-row-sub">Grade {person.grade}</span>}
                </div>
                <div className="cls-person-actions">
                  <button type="button" className="cls-btn quiet small" disabled={busy !== null} aria-label={`Message ${person.name}'s parents`}
                    onClick={() => open(`parents:${person.id}`, person.id)}>
                    {busy === `parents:${person.id}` ? "Opening…" : "Message parents"}
                  </button>
                </div>
              </li>)}</ul>
            : <p className="cls-note">No students are enrolled in {data.klass.title} yet.</p>}
        </section>
      : <section aria-label="Your children">
          <h3 className="cls-section-title">Your {data.kids.length === 1 ? "child" : "children"} in this class</h3>
          <ul className="cls-chips">{data.kids.map((kid) => <li key={kid.id} className="cls-chip">{kid.name}</li>)}</ul>
        </section>}

    <p className={`cls-status${problem ? " bad" : ""}`} role="status">{problem}</p>
  </>;
}

/** One button per teacher when a family has one child here; one per child when they have several. */
function MessageTeacher({ teacher, kids, busy, onOpen }: {
  teacher: Teacher; kids: Kid[]; busy: string | null; onOpen: (key: string, childId: string, teacherId?: string) => void;
}) {
  return <>
    {kids.map((kid) => {
      const key = `teacher:${teacher.id}:${kid.id}`;
      return <button key={kid.id} type="button" className="cls-btn quiet small" disabled={busy !== null} onClick={() => onOpen(key, kid.id, teacher.id)}>
        {busy === key ? "Opening…" : kids.length === 1 ? `Message ${teacher.name}` : `Message ${teacher.name} about ${kid.name}`}
      </button>;
    })}
  </>;
}
