/**
 * What the Children screens show, worked out from rows already loaded.
 *
 * No fetching here: app/family-village/children/use-children.ts loads the rows
 * once for the whole family, and these functions turn them into the next co-op
 * day on a Today card, the assignments a parent can tick, and the class picker
 * in the enrollment step. Kept free of React and Supabase so the tests can run
 * them directly.
 */

import { describeSchedule, formatBlockTime, formatTimeOfDay, nextMeetingDay, type ClassSchedule } from "./schedule";

export type ChildTeacher = { id: string; name: string; role: "lead" | "assistant" | null };

export type ChildClass = {
  id: string;
  title: string;
  /** "Friday · Block A · 10:00 – 10:50 AM · Room 2", or a fallback. */
  when: string;
  /** "10:00 – 10:50 AM", or "" when the class has no block yet. */
  time: string;
  /** The block's start, "10:00:00", for ordering a day. */
  startsAt: string | null;
  /** The next day the class meets, "YYYY-MM-DD", or null. */
  nextMeeting: string | null;
  teachers: ChildTeacher[];
};

export type ChildDate = {
  id: string;
  title: string;
  /** "YYYY-MM-DD". Class dates are stored at midday UTC, so the first ten characters are the day. */
  day: string;
  location: string | null;
  requiresPrework: boolean;
  classId: string;
  classTitle: string;
  completed: boolean;
};

/** A class row as the enrollment query embeds it. */
export type RawChildClass = {
  id: string;
  title: string;
  class_terms?: { academic_terms: { starts_on: string; ends_on: string } | null }[] | null;
  teacher_assignments?: { user_id: string; assignment_role?: "lead" | "assistant" | null; profiles: { display_name: string | null; email: string } | null }[] | null;
} & Partial<ClassSchedule>;

function termsOf(row: { class_terms?: RawChildClass["class_terms"] }) {
  return (row.class_terms ?? [])
    .map((link) => link.academic_terms)
    .filter((term): term is { starts_on: string; ends_on: string } => !!term);
}

export function toChildClass(row: RawChildClass, today: Date = new Date()): ChildClass {
  return {
    id: row.id,
    title: row.title,
    when: describeSchedule(row),
    time: formatBlockTime(row.class_blocks ?? null),
    startsAt: row.class_blocks?.starts_at ?? null,
    nextMeeting: nextMeetingDay(row.class_blocks?.day_of_week, termsOf(row), today),
    teachers: (row.teacher_assignments ?? [])
      .map((assignment) => ({
        id: assignment.user_id,
        name: assignment.profiles?.display_name || assignment.profiles?.email || "",
        role: assignment.assignment_role ?? null,
      }))
      .filter((teacher) => teacher.name)
      // Lead teachers first, so "Message ..." and the card line name the teacher a parent expects.
      .sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead")),
  };
}

/** The teacher a card names: the lead teachers, or everyone when no lead is set. */
export function teacherLine(teachers: ChildTeacher[]) {
  const leads = teachers.filter((teacher) => teacher.role === "lead");
  return (leads.length ? leads : teachers).map((teacher) => teacher.name).join(", ");
}

export type NextCoopDay = {
  /** "YYYY-MM-DD", or null when none of the child's classes has a meeting ahead. */
  day: string | null;
  /** The classes that meet that day, in time order. */
  classes: ChildClass[];
  /** Assignments due by that day (or the next few, when no day is known). */
  assignments: ChildDate[];
};

/**
 * One child's next co-op day: the earliest next meeting across their classes,
 * the classes that meet then, and the assignments due on or before it. Today
 * counts, so a Friday morning card still shows that Friday.
 */
export function nextCoopDay(classes: ChildClass[], dates: ChildDate[], today: string): NextCoopDay {
  const days = classes.map((row) => row.nextMeeting).filter((day): day is string => !!day).sort();
  const day = days[0] ?? null;
  const meeting = day
    ? classes.filter((row) => row.nextMeeting === day).sort((a, b) => (a.startsAt ?? "99").localeCompare(b.startsAt ?? "99") || a.title.localeCompare(b.title))
    : [];
  const prework = dates.filter((row) => row.requiresPrework && row.day >= today).sort((a, b) => a.day.localeCompare(b.day));
  const assignments = day ? prework.filter((row) => row.day <= day) : prework.slice(0, 3);
  return { day, classes: meeting, assignments };
}

/** "Friday, Nov 27" from "2026-11-27", read as a plain calendar day. */
export function formatCoopDay(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

/** "10:00 AM" for a class line on a card. */
export function classStartLabel(row: Pick<ChildClass, "startsAt">) {
  return formatTimeOfDay(row.startsAt);
}

// --- enrollment ------------------------------------------------------------------

export type EnrollOption = {
  id: string;
  title: string;
  description: string | null;
  when: string;
  /** Classes in the same block meet at the same time; a child can take one of them. Null when no block is set. */
  blockKey: string | null;
  isFull: boolean;
  missingPrerequisites: string[];
};

export type RawEnrollClass = {
  id: string; title: string; description: string | null; is_elective: boolean; grades: string[] | null;
  class_terms: { academic_terms: { starts_on: string; ends_on: string } | null }[] | null;
} & Partial<ClassSchedule>;

/**
 * Which of the co-op's open classes a child could be offered: their grade
 * matches (an empty grades list means any grade), they are not already in it,
 * and it has a term that has not ended (no term means year-round, the same rule
 * the database's clash check uses). An enrollment window often opens before the
 * term starts, so a term that has not started yet still counts.
 */
export function matchEnrollable(rows: RawEnrollClass[], grade: string | null, alreadyIn: Set<string>, today: string) {
  if (!grade) return [];
  return rows
    .filter((row) => !row.grades?.length || row.grades.includes(grade))
    .filter((row) => !alreadyIn.has(row.id))
    .filter((row) => {
      const terms = termsOf(row);
      return !terms.length || terms.some((term) => today <= term.ends_on);
    });
}

export function toEnrollOption(row: RawEnrollClass, lock: { is_full: boolean; missing_prerequisites: string[] | null } | undefined): EnrollOption {
  const block = row.class_blocks ?? null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    when: describeSchedule(row),
    blockKey: block ? `${block.day_of_week}|${block.starts_at}` : null,
    isFull: lock?.is_full ?? false,
    missingPrerequisites: lock?.missing_prerequisites ?? [],
  };
}

/** Why a class cannot be picked, or null when it can. */
export function lockReason(option: Pick<EnrollOption, "isFull" | "missingPrerequisites">) {
  if (option.isFull) return "Class full";
  if (option.missingPrerequisites.length) return `Requires ${option.missingPrerequisites.join(", ")} first`;
  return null;
}

/**
 * Ticks or unticks a class in a child's picks. Picking a class drops any other
 * pick in the same block, since a child cannot be in two places at 1:00. The
 * server checks clashes again when enrolling; this only keeps the picker honest.
 */
export function togglePick(picks: string[], option: EnrollOption, options: EnrollOption[]) {
  if (lockReason(option)) return picks;
  if (picks.includes(option.id)) return picks.filter((id) => id !== option.id);
  const sameBlock = new Set(options.filter((other) => option.blockKey && other.blockKey === option.blockKey).map((other) => other.id));
  return [...picks.filter((id) => !sameBlock.has(id)), option.id];
}
