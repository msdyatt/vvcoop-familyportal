"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrls } from "../../../lib/storage";
import { SCHEDULE_SELECT } from "../../../lib/schedule";
import {
  matchEnrollable, toChildClass, toEnrollOption,
  type ChildClass, type ChildDate, type EnrollOption, type RawChildClass, type RawEnrollClass,
} from "../../../lib/children-view";

/**
 * Everything the Children screens read, loaded once for a set of children.
 *
 * The Today cards, the Children page, the Edit pop-up and the admin's child
 * pop-up all take their rows from here, so a family with three children makes
 * the same five requests as a family with one, rather than one round per card.
 * Row level security decides what comes back: a parent gets their own
 * household's children, an administrator gets the child they opened.
 */

export type ChildRecord = {
  id: string; first_name: string; last_name: string | null; last_initial: string | null;
  age_band: string | null; age_band_override: boolean; birthdate: string | null; avatar_path: string | null;
};

export type ChildOverview = {
  child: ChildRecord;
  avatarUrl: string | null;
  classes: ChildClass[];
  /** Upcoming class dates (topics and assignments) for this child's classes, soonest first. */
  dates: ChildDate[];
};

export type OpenPeriod = { id: string; title: string; closes_at: string; electives_only: boolean };

const CHILD_FIELDS = "id,first_name,last_name,last_initial,age_band,age_band_override,birthdate,avatar_path";
const CLASS_EMBED = `classes(id,title,${SCHEDULE_SELECT},class_terms(academic_terms(starts_on,ends_on)),teacher_assignments(user_id,assignment_role,profiles(display_name,email)))`;

/** "YYYY-MM-DD" for the browser's own today. */
export function localToday(now: Date = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export async function loadOpenPeriod(supabase: SupabaseClient): Promise<OpenPeriod | null> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase.from("enrollment_periods")
    .select("id,title,closes_at,electives_only").eq("active", true)
    .lte("opens_at", nowIso).gte("closes_at", nowIso).limit(1);
  return ((data ?? [])[0] as OpenPeriod | undefined) ?? null;
}

async function loadChildren(supabase: SupabaseClient, childIds: string[]) {
  const [{ data: childRows, error }, { data: enrollmentRows }, period] = await Promise.all([
    supabase.from("children").select(CHILD_FIELDS).in("id", childIds).order("first_name"),
    supabase.from("enrollments").select(`child_id,class_id,${CLASS_EMBED}`).in("child_id", childIds).eq("status", "active"),
    loadOpenPeriod(supabase),
  ]);
  if (error) throw error;
  const children = (childRows ?? []) as ChildRecord[];
  const enrollments = ((enrollmentRows ?? []) as unknown as { child_id: string; class_id: string; classes: RawChildClass | null }[])
    .filter((row) => row.classes);

  const now = new Date();
  const classById = new Map<string, ChildClass>();
  for (const row of enrollments) if (!classById.has(row.class_id)) classById.set(row.class_id, toChildClass(row.classes!, now));
  const classIds = [...classById.keys()];

  // From the start of today: class dates sit at midday UTC, so "now" would drop
  // a Friday's own date partway through that Friday morning.
  const { data: dateRows } = classIds.length
    ? await supabase.from("events")
        .select("id,title,starts_at,location,requires_prework,class_id")
        .eq("audience", "class").in("class_id", classIds)
        .gte("starts_at", `${localToday(now)}T00:00:00.000Z`)
        .order("starts_at", { ascending: true }).limit(80)
    : { data: [] };
  const dates = (dateRows ?? []) as { id: string; title: string; starts_at: string; location: string | null; requires_prework: boolean; class_id: string }[];
  const preworkIds = dates.filter((row) => row.requires_prework).map((row) => row.id);

  const [{ data: completionRows }, avatarUrls] = await Promise.all([
    preworkIds.length
      ? supabase.from("event_completions").select("event_id,child_id").in("event_id", preworkIds).in("child_id", childIds)
      : Promise.resolve({ data: [] as { event_id: string; child_id: string }[] }),
    getSignedFileUrls(supabase, children.map((child) => child.avatar_path).filter((path): path is string => !!path)),
  ]);
  const done = new Set((completionRows ?? []).map((row) => `${row.event_id}:${row.child_id}`));

  const overviews: ChildOverview[] = children.map((child) => {
    const mine = new Set(enrollments.filter((row) => row.child_id === child.id).map((row) => row.class_id));
    return {
      child,
      avatarUrl: child.avatar_path ? avatarUrls.get(child.avatar_path) ?? null : null,
      // In the order of the day: History at 10 before Science at 11 before the electives.
      classes: [...mine].map((id) => classById.get(id)!).sort((a, b) =>
        (a.nextMeeting ?? "9999").localeCompare(b.nextMeeting ?? "9999") || (a.startsAt ?? "99").localeCompare(b.startsAt ?? "99") || a.title.localeCompare(b.title)),
      dates: dates.filter((row) => mine.has(row.class_id)).map((row) => ({
        id: row.id, title: row.title, day: row.starts_at.slice(0, 10), location: row.location,
        requiresPrework: row.requires_prework, classId: row.class_id,
        classTitle: classById.get(row.class_id)?.title ?? "",
        completed: done.has(`${row.id}:${child.id}`),
      })),
    };
  });
  return { overviews, period };
}

export type ChildrenState = {
  loading: boolean;
  error: string;
  children: ChildOverview[];
  period: OpenPeriod | null;
  reload: () => Promise<void>;
  /** Ticks or unticks an assignment for one child. Returns an error message, or "" when it saved. */
  toggleCompletion: (childId: string, eventId: string, done: boolean) => Promise<string>;
};

export function useChildren(childIds: string[]): ChildrenState {
  const key = [...childIds].sort().join(",");
  const [state, setState] = useState<{ loading: boolean; error: string; children: ChildOverview[]; period: OpenPeriod | null }>({ loading: !!key, error: "", children: [], period: null });
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !key) { setState({ loading: false, error: "", children: [], period: null }); return; }
    const run = ++latest.current;
    try {
      const { overviews, period } = await loadChildren(supabase, key.split(","));
      if (run === latest.current) setState({ loading: false, error: "", children: overviews, period });
    } catch {
      if (run === latest.current) setState((current) => ({ ...current, loading: false, error: "Could not load your children's classes. Try again." }));
    }
  }, [key]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when the set of children changes
  useEffect(() => { reload(); }, [reload]);

  const toggleCompletion = useCallback(async (childId: string, eventId: string, done: boolean) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return "Not connected.";
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return "Please sign in again.";
    const { error } = done
      ? await supabase.from("event_completions").delete().eq("event_id", eventId).eq("child_id", childId)
      : await supabase.from("event_completions").insert({ event_id: eventId, child_id: childId, completed_by: auth.user.id });
    if (error) return error.message;
    // Only the one tick changed, so update it in place rather than reloading the family.
    setState((current) => ({
      ...current,
      children: current.children.map((entry) => entry.child.id !== childId ? entry : {
        ...entry, dates: entry.dates.map((row) => row.id === eventId ? { ...row, completed: !done } : row),
      }),
    }));
    return "";
  }, []);

  return { ...state, reload, toggleCompletion };
}

/**
 * The classes a child can be offered in the open window, with the full-class
 * and prerequisite locks. Loaded only when the enrollment step opens.
 *
 * Capacity and prerequisites can't be worked out in the browser (a family can't
 * read other households' enrollments to count seats), so the SECURITY DEFINER
 * family_enrollment_options says which are full and what is still missing. A
 * locked class is still shown, greyed out with the reason: "why can't I pick
 * this" is worse than seeing it. Classes that place themselves by grade
 * (History, Science) are never offered for a family to pick.
 */
export async function loadEnrollOptions(supabase: SupabaseClient, child: ChildRecord, period: OpenPeriod): Promise<EnrollOption[]> {
  if (!child.age_band) return [];
  let classQuery = supabase.from("classes")
    .select(`id,title,description,is_elective,grades,${SCHEDULE_SELECT},class_terms(academic_terms(starts_on,ends_on))`)
    .eq("active", true)
    .is("subject", null);
  if (period.electives_only) classQuery = classQuery.eq("is_elective", true);
  const [{ data: classRows }, { data: enrolledRows }] = await Promise.all([
    classQuery.order("title"),
    supabase.from("enrollments").select("class_id").eq("child_id", child.id).eq("status", "active"),
  ]);
  const alreadyIn = new Set((enrolledRows ?? []).map((row) => row.class_id as string));
  const matched = matchEnrollable((classRows ?? []) as unknown as RawEnrollClass[], child.age_band, alreadyIn, localToday());
  if (!matched.length) return [];
  const { data: optionRows } = await supabase.rpc("family_enrollment_options", {
    p_child_id: child.id, p_class_ids: matched.map((row) => row.id),
  });
  const locks = new Map(((optionRows ?? []) as { class_id: string; is_full: boolean; missing_prerequisites: string[] | null }[])
    .map((row) => [row.class_id, row]));
  return matched.map((row) => toEnrollOption(row, locks.get(row.id)));
}

/**
 * Enrolls straight away, with no approval step. family_self_enroll checks
 * everything again on the server (window open, grade, same-block clash, seats,
 * prerequisites) rather than trusting the picker, which was built from what
 * the page loaded, not the moment of clicking.
 */
export async function selfEnroll(supabase: SupabaseClient, periodId: string, childId: string, classId: string) {
  const { error } = await supabase.rpc("family_self_enroll", { p_period_id: periodId, p_class_id: classId, p_child_id: childId });
  return error?.message ?? "";
}
