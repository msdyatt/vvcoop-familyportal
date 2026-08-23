"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../lib/storage";
import Avatar from "./avatar";
import { GRADES } from "./admin/admin-ui";
import { ClassSchedule, SCHEDULE_SELECT, describeSchedule } from "../../lib/schedule";

type ClassInfo = { id: string; title: string; schedule: string; teachers: string[] };
type ClassDateInfo = { id: string; title: string; starts_at: string; location: string | null; requires_prework: boolean; class_title: string; completed: boolean };
type NoteInfo = { id: string; body: string; visibility: string; created_at: string; author_user_id: string; class_id: string; author_name: string; class_title: string; read_count: number; read_by_me: boolean };

type ChildRecord = { id: string; first_name: string; last_name: string | null; age_band: string | null; age_band_override: boolean; birthdate: string | null; avatar_path: string | null };

type OpenPeriod = { id: string; title: string; closes_at: string; electives_only: boolean };
type EligibleClass = { id: string; title: string; is_elective: boolean };

export default function ChildDetail({ childId, onClose }: { childId: string; onClose: () => void }) {
  const [child, setChild] = useState<ChildRecord | null>(null);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classDates, setClassDates] = useState<ClassDateInfo[]>([]);
  const [openPeriod, setOpenPeriod] = useState<OpenPeriod | null>(null);
  const [eligibleClasses, setEligibleClasses] = useState<EligibleClass[]>([]);
  const [classPick, setClassPick] = useState("");
  const [enrollStatus, setEnrollStatus] = useState("");
  const [childStatus, setChildStatus] = useState("");
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [userId, setUserId] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: authData } = await supabase.auth.getUser();
    const uid = authData.user?.id ?? "";
    setUserId(uid);

    const [{ data: childRow }, { data: enrollments }, { data: noteRows }] = await Promise.all([
      supabase.from("children").select("id,first_name,last_name,age_band,age_band_override,birthdate,avatar_path").eq("id", childId).single(),
      supabase.from("enrollments").select(`class_id,status,classes(id,title,${SCHEDULE_SELECT},teacher_assignments(profiles(display_name,email)))`).eq("child_id", childId).eq("status", "active"),
      supabase.from("teacher_notes").select("id,body,visibility,created_at,author_user_id,class_id").eq("child_id", childId).order("created_at", { ascending: false }),
    ]);
    setChild(childRow as ChildRecord | null);
    setAvatarUrl(childRow?.avatar_path ? await getSignedFileUrl(supabase, childRow.avatar_path) : null);
    const rows = (enrollments ?? []) as unknown as { classes: { id: string; title: string; teacher_assignments: { profiles: { display_name: string | null; email: string } | null }[] } & ClassSchedule }[];
    const classInfos = rows.map((row) => ({
      id: row.classes.id,
      title: row.classes.title,
      schedule: describeSchedule(row.classes),
      teachers: row.classes.teacher_assignments.map((assignment) => assignment.profiles?.display_name || assignment.profiles?.email || "").filter(Boolean),
    }));
    setClasses(classInfos);

    const noteBaseRows = (noteRows ?? []) as Omit<NoteInfo, "author_name" | "class_title" | "read_count" | "read_by_me">[];
    const authorIds = [...new Set(noteBaseRows.map((row) => row.author_user_id))];
    const noteClassIds = [...new Set(noteBaseRows.map((row) => row.class_id))];
    const noteIds = noteBaseRows.map((row) => row.id);
    const [{ data: authorRows }, { data: classRows }, { data: readRows }] = await Promise.all([
      authorIds.length ? supabase.from("profiles").select("id,display_name,email").in("id", authorIds) : Promise.resolve({ data: [] }),
      noteClassIds.length ? supabase.from("classes").select("id,title").in("id", noteClassIds) : Promise.resolve({ data: [] }),
      noteIds.length ? supabase.from("teacher_note_reads").select("note_id,user_id").in("note_id", noteIds) : Promise.resolve({ data: [] }),
    ]);
    const authorMap = new Map((authorRows ?? []).map((row) => [row.id, row.display_name || row.email]));
    const classMap = new Map((classRows ?? []).map((row) => [row.id, row.title]));
    const readCounts = new Map<string, number>();
    const readByMe = new Set<string>();
    (readRows ?? []).forEach((row) => {
      readCounts.set(row.note_id, (readCounts.get(row.note_id) ?? 0) + 1);
      if (row.user_id === uid) readByMe.add(row.note_id);
    });
    setNotes(noteBaseRows.map((row) => ({
      ...row,
      author_name: authorMap.get(row.author_user_id) ?? "Teacher",
      class_title: classMap.get(row.class_id) ?? "",
      read_count: readCounts.get(row.id) ?? 0,
      read_by_me: readByMe.has(row.id),
    })));

    const classIds = classInfos.map((info) => info.id);
    if (classIds.length) {
      // Class dates replaced assignments -- one entry carries the topic, the
      // date and whether anything is needed beforehand.
      const { data: dateRows } = await supabase.from("events")
        .select("id,title,starts_at,location,requires_prework,class_id,classes(title)")
        .eq("audience", "class").in("class_id", classIds)
        .gte("starts_at", new Date().toISOString())
        .order("starts_at", { ascending: true }).limit(10);
      const dateBase = (dateRows ?? []) as unknown as { id: string; title: string; starts_at: string; location: string | null; requires_prework: boolean; classes: { title: string } }[];
      const eventIds = dateBase.filter((row) => row.requires_prework).map((row) => row.id);
      const { data: completionRows } = eventIds.length
        ? await supabase.from("event_completions").select("event_id").eq("child_id", childId).in("event_id", eventIds)
        : { data: [] };
      const completed = new Set((completionRows ?? []).map((row) => row.event_id));
      setClassDates(dateBase.map((row) => ({
        id: row.id, title: row.title, starts_at: row.starts_at, location: row.location,
        requires_prework: row.requires_prework, class_title: row.classes?.title ?? "",
        completed: completed.has(row.id),
      })));
    }

    // Enrollment: is a window open right now, and what can this child request
    // in it. A child with no grade set yet can't be matched against anything,
    // so the section quietly has nothing to offer rather than showing every
    // class in the co-op.
    const nowIso = new Date().toISOString();
    const { data: periodRows } = await supabase.from("enrollment_periods")
      .select("id,title,closes_at,electives_only").eq("active", true)
      .lte("opens_at", nowIso).gte("closes_at", nowIso).limit(1);
    const period = (periodRows ?? [])[0] as OpenPeriod | undefined;
    setOpenPeriod(period ?? null);

    if (period && childRow?.age_band) {
      let classQuery = supabase.from("classes").select("id,title,is_elective")
        .eq("active", true).contains("grades", [childRow.age_band]);
      if (period.electives_only) classQuery = classQuery.eq("is_elective", true);

      const [{ data: classRows2 }, { data: enrolledRows }] = await Promise.all([
        classQuery,
        supabase.from("enrollments").select("class_id").eq("child_id", childId).eq("status", "active"),
      ]);
      const alreadyIn = new Set((enrolledRows ?? []).map((row) => row.class_id));
      setEligibleClasses((classRows2 ?? []).filter((row) => !alreadyIn.has(row.id)));
    } else {
      setEligibleClasses([]);
    }

    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- initial data fetch on mount
  useEffect(() => { load(); }, [childId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function markRead(noteId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;
    const { error } = await supabase.from("teacher_note_reads").insert({ note_id: noteId, user_id: userId });
    if (!error) await load();
  }

  async function deleteNote(noteId: string) {
    if (!confirm("Delete this note? This cannot be undone.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("teacher_notes").delete().eq("id", noteId);
    if (!error) await load();
  }

  /**
   * A family can change a child's photo, birthdate, and grade override --
   * nothing else. The database enforces the same boundary (a trigger rejects
   * any other column in the same update), so this is convenience, not the
   * real gate.
   */
  async function updateChild(patch: { avatar_path?: string; birthdate?: string | null; age_band_override?: boolean; age_band?: string | null }, savedMessage = "Saved.") {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("children").update(patch).eq("id", childId);
    if (error) { setChildStatus(error.message); return; }
    setChildStatus(savedMessage);
    await load();
  }

  async function uploadAvatar(file: File) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setChildStatus("Uploading…");
    const uploaded = await uploadPrivateFile(supabase, "avatars", file);
    if ("error" in uploaded) { setChildStatus(uploaded.error); return; }
    await updateChild({ avatar_path: uploaded.path }, "Photo updated.");
  }

  async function toggleCompletion(eventId: string, done: boolean) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;
    const action = done
      ? supabase.from("event_completions").delete().eq("event_id", eventId).eq("child_id", childId)
      : supabase.from("event_completions").insert({ event_id: eventId, child_id: childId, completed_by: userId });
    const { error } = await action;
    if (!error) await load();
  }

  /**
   * Enrolls immediately -- no admin approval step. family_self_enroll
   * re-checks eligibility server-side (window open, grade matches, no
   * same-block clash) rather than trusting the picker's own filtering, since
   * that list was built from what the page loaded with, not the instant of
   * clicking.
   */
  async function enrollInClass() {
    if (!openPeriod || !classPick) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;
    setEnrollStatus("Enrolling…");
    const { error } = await supabase.rpc("family_self_enroll", {
      p_period_id: openPeriod.id, p_class_id: classPick, p_child_id: childId,
    });
    if (error) {
      setEnrollStatus(error.message);
      return;
    }
    const enrolledTitle = eligibleClasses.find((option) => option.id === classPick)?.title ?? "the class";
    setClassPick("");
    setEnrollStatus(`Enrolled in ${enrolledTitle}.`);
    await load();
  }

  return <div className="child-detail-overlay" role="dialog" aria-modal="true">
    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- decorative backdrop; Escape and the close button provide keyboard access */}
    <div className="child-detail-backdrop" onClick={onClose} />
    <div className="child-detail-panel">
      <button className="child-detail-close" onClick={onClose} aria-label="Close">×</button>
      {loading ? <p>Loading…</p> : <>
        <p className="eyebrow">Student</p>
        <div className="child-detail-heading">
          <Avatar url={avatarUrl} label={child?.first_name ?? "?"} size="lg" />
          <h2>{child?.first_name} {child?.last_name}</h2>
        </div>

        <section>
          <p className="card-kicker">About {child?.first_name}</p>
          <div className="field-grid">
            <label className="file-drop"><span className="field-caption">Photo</span>
              <input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadAvatar(file); }} />
            </label>
            <label>Birthdate<input type="date" value={child?.birthdate ?? ""} onChange={(event) => updateChild({ birthdate: event.target.value || null })} /></label>
            <label className="checkbox-field">
              <input type="checkbox" checked={child?.age_band_override ?? false} onChange={(event) => updateChild({ age_band_override: event.target.checked })} /> Set grade manually
            </label>
            {child?.age_band_override
              ? <label>Grade<select value={child?.age_band ?? ""} onChange={(event) => updateChild({ age_band: event.target.value || null })}>
                  <option value="">Not set</option>
                  {GRADES.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                </select></label>
              : <p className="field-note">
                  {child?.birthdate ? `Grade ${child?.age_band ?? "not yet set"}, calculated from birthdate.` : "Add a birthdate to calculate grade automatically."}
                </p>}
          </div>
          {childStatus && <p className="admin-form-status" role="status">{childStatus}</p>}
        </section>

        <section>
          <p className="card-kicker">Classes</p>
          {classes.length ? <ul className="child-detail-list">{classes.map((row) => <li key={row.id}><b>{row.title}</b><span>{row.schedule}{row.teachers.length ? ` · ${row.teachers.join(", ")}` : ""}</span></li>)}</ul> : <p className="portal-empty">Not enrolled in any classes yet.</p>}
        </section>

        <section>
          <p className="card-kicker">Coming up in class</p>
          {classDates.length
            ? <ul className="child-detail-list">{classDates.map((row) => <li key={row.id}>
                <b>{row.title}</b>
                <span>{[row.class_title, new Date(row.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }), row.location].filter(Boolean).join(" · ")}</span>
                {row.requires_prework && <label className={`prep-flag${row.completed ? " prep-done" : ""}`}>
                  <input type="checkbox" checked={row.completed} onChange={() => toggleCompletion(row.id, row.completed)} />
                  {row.completed ? "Assignment ready" : "Assignment"}
                </label>}
              </li>)}</ul>
            : <p className="portal-empty">Nothing scheduled in this child&rsquo;s classes right now.</p>}
        </section>

        {openPeriod && <section>
          <p className="card-kicker">Enrollment is open</p>
          <p className="field-note">
            {openPeriod.title} closes {new Date(openPeriod.closes_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}.
            {openPeriod.electives_only ? " Choose electives for " : " Choose classes for "}{child?.first_name} — enrolling is immediate, no approval needed.
          </p>
          {eligibleClasses.length
            ? <div className="row-actions">
                <select value={classPick} onChange={(event) => setClassPick(event.target.value)}>
                  <option value="">Choose a class…</option>
                  {eligibleClasses.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
                </select>
                <button disabled={!classPick} onClick={enrollInClass}>Enroll</button>
              </div>
            : <p className="portal-empty">No open classes match {child?.first_name}&rsquo;s grade right now.</p>}
          {enrollStatus && <p className="admin-form-status" role="status">{enrollStatus}</p>}
        </section>}

        <section>
          <p className="card-kicker">Teacher notes</p>
          {notes.length ? <ul className="child-detail-list note-list">{notes.map((row) => <li key={row.id}>
            <span>{row.author_name} · {row.class_title} · {new Date(row.created_at).toLocaleDateString()} · {row.visibility}</span>
            <p>{row.body}</p>
            <div className="note-actions">
              {row.read_by_me
                ? <span className="note-read-pill">Marked as read</span>
                : <button onClick={() => markRead(row.id)}>Mark as read</button>}
              {row.read_count > 0 && <span className="note-read-count">Read by {row.read_count}</span>}
              {row.author_user_id === userId && <button className="danger" onClick={() => deleteNote(row.id)}>Delete</button>}
            </div>
          </li>)}</ul> : <p className="portal-empty">No notes yet.</p>}
        </section>
      </>}
    </div>
  </div>;
}
