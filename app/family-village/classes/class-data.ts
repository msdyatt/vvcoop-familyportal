import type { SupabaseClient } from "@supabase/supabase-js";
import { ClassSchedule, SCHEDULE_SELECT, describeSchedule, formatBlockTime, formatWeekday, nextMeetingDay } from "../../../lib/schedule";

/**
 * What the class list and the class page read.
 *
 * Nothing here decides who may see what: every query goes through the signed-in
 * person's own session, so row level security does it. A teacher gets the
 * enrollments of classes they are assigned to, a parent gets their own children's
 * enrollments, and a class a person has no link to simply comes back empty.
 */

const CLASS_FIELDS = `id,title,description,grades,is_elective,capacity,active,school_year_id,${SCHEDULE_SELECT},class_terms(academic_terms(starts_on,ends_on))`;

type RawClass = {
  id: string; title: string; description: string | null; grades: string[]; is_elective: boolean;
  capacity: number | null; active: boolean; school_year_id: string | null;
  class_blocks: ClassSchedule["class_blocks"];
  rooms: ClassSchedule["rooms"];
  class_terms: { academic_terms: { starts_on: string; ends_on: string } | null }[];
};

export type TeachingRole = "lead" | "assistant";
export type Teacher = { id: string; name: string; role: TeachingRole };
export type Kid = { id: string; name: string };

/** A class as the person looking at it needs to describe it. */
export type ClassCore = {
  id: string; title: string; description: string | null; grades: string[]; isElective: boolean;
  capacity: number | null; active: boolean; schoolYearId: string | null;
  /** "Friday · Block A · 9:00 – 10:15 AM", or a fallback when the class has no block yet. */
  when: string;
  weekday: string;
  time: string;
  room: string | null;
  nextMeeting: string | null;
  ended: boolean;
};

export type ClassDate = {
  id: string; title: string; description: string | null; location: string | null;
  /** "YYYY-MM-DD" */
  day: string; startsAt: string; requiresPrework: boolean;
};

function core(row: RawClass, today: Date): ClassCore {
  const terms = row.class_terms.map((link) => link.academic_terms).filter((term): term is { starts_on: string; ends_on: string } => !!term);
  const next = nextMeetingDay(row.class_blocks?.day_of_week, terms, today);
  const todayDay = toLocalDay(today);
  return {
    id: row.id, title: row.title, description: row.description, grades: row.grades ?? [], isElective: row.is_elective,
    capacity: row.capacity, active: row.active, schoolYearId: row.school_year_id,
    when: describeSchedule(row, "Schedule to be announced"),
    weekday: row.class_blocks ? formatWeekday(row.class_blocks.day_of_week) : "",
    time: formatBlockTime(row.class_blocks),
    room: row.rooms?.name ?? null,
    nextMeeting: next,
    // Over when every term it belongs to has ended.
    ended: terms.length > 0 && terms.every((term) => term.ends_on < todayDay),
  };
}

export function toLocalDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "Pre-K", "K", "3" ... as one phrase: "Grades 3–5", "Grade K", "All grades". */
export function gradesLabel(grades: string[]) {
  if (!grades.length) return "All grades";
  const order = ["Pre-K", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const sorted = [...grades].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (sorted.length === 1) return `Grade ${sorted[0]}`;
  const indexes = sorted.map((grade) => order.indexOf(grade));
  const consecutive = indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1);
  return consecutive ? `Grades ${sorted[0]}–${sorted[sorted.length - 1]}` : `Grades ${sorted.join(", ")}`;
}

function dateOf(row: { id: string; title: string; description: string | null; location: string | null; starts_at: string; requires_prework: boolean }): ClassDate {
  return {
    id: row.id, title: row.title, description: row.description, location: row.location,
    // Class dates are stored at midday UTC so the day never slides when read back.
    day: row.starts_at.slice(0, 10), startsAt: row.starts_at, requiresPrework: row.requires_prework,
  };
}

// --- the lists ---------------------------------------------------------------------

export type ClassCardData = ClassCore & {
  /** Set when the person teaches this class. */
  role: TeachingRole | null;
  /** Their own children in it (families). */
  kids: Kid[];
  teachers: Teacher[];
  studentCount: number | null;
  nextDate: ClassDate | null;
  /** A parent's own children still have prep to do for the next class date. Never set for teachers. */
  prepNeeded: boolean;
  fileCount: number;
  /** The class message channel, when one exists and this person is in it. */
  chatId: string | null;
};

export type Overview = { teaching: ClassCardData[]; family: ClassCardData[]; currentYearId: string | null };

type Assignment = { class_id: string; assignment_role: TeachingRole; classes: RawClass | null };
type TeacherRow = { class_id: string; assignment_role: TeachingRole; user_id: string; profiles: { display_name: string | null; email: string } | null };

function teacherFromRow(row: TeacherRow): Teacher {
  return { id: row.user_id, name: row.profiles?.display_name || row.profiles?.email || "", role: row.assignment_role };
}

export async function loadOverview(supabase: SupabaseClient, userId: string): Promise<Overview> {
  const today = new Date();
  const [{ data: assignmentRows }, { data: membership }, { data: years }] = await Promise.all([
    supabase.from("teacher_assignments").select(`class_id,assignment_role,classes(${CLASS_FIELDS})`).eq("user_id", userId),
    supabase.from("family_members").select("family_id").eq("user_id", userId),
    supabase.from("school_years").select("id,is_current"),
  ]);
  const currentYearId = ((years ?? []) as { id: string; is_current: boolean }[]).find((year) => year.is_current)?.id ?? null;
  const assignments = ((assignmentRows ?? []) as unknown as Assignment[]).filter((row) => row.classes);

  const familyIds = (membership ?? []).map((row) => row.family_id as string);
  const { data: childRows } = familyIds.length
    ? await supabase.from("children").select("id,first_name").in("family_id", familyIds).eq("active", true).order("first_name")
    : { data: [] };
  const children = (childRows ?? []) as { id: string; first_name: string }[];
  const { data: enrollmentRows } = children.length
    ? await supabase.from("enrollments").select(`child_id,class_id,classes(${CLASS_FIELDS})`).in("child_id", children.map((child) => child.id)).eq("status", "active")
    : { data: [] };
  const enrollments = (enrollmentRows ?? []) as unknown as { child_id: string; class_id: string; classes: RawClass | null }[];

  const teachingIds = assignments.map((row) => row.class_id);
  const familyClassIds = [...new Set(enrollments.map((row) => row.class_id))];
  const allIds = [...new Set([...teachingIds, ...familyClassIds])];
  if (!allIds.length) return { teaching: [], family: [], currentYearId };

  const todayDay = toLocalDay(today);
  const [{ data: teacherRows }, { data: rosterRows }, { data: eventRows }, { data: documentRows }, { data: chatRows }] = await Promise.all([
    supabase.from("teacher_assignments").select("class_id,assignment_role,user_id,profiles(display_name,email)").in("class_id", allIds),
    teachingIds.length ? supabase.from("enrollments").select("class_id").in("class_id", teachingIds).eq("status", "active") : Promise.resolve({ data: [] }),
    supabase.from("events").select("id,class_id,title,description,location,starts_at,requires_prework").eq("audience", "class").in("class_id", allIds).gte("starts_at", `${todayDay}T00:00:00Z`).order("starts_at").limit(300),
    supabase.from("documents").select("class_id").in("class_id", allIds),
    supabase.from("conversations").select("id,class_id").in("class_id", allIds),
  ]);

  const teachersByClass = new Map<string, Teacher[]>();
  for (const row of (teacherRows ?? []) as unknown as TeacherRow[]) {
    const teacher = teacherFromRow(row);
    if (!teacher.name) continue;
    teachersByClass.set(row.class_id, [...(teachersByClass.get(row.class_id) ?? []), teacher]);
  }
  const counts = new Map<string, number>();
  for (const row of (rosterRows ?? []) as { class_id: string }[]) counts.set(row.class_id, (counts.get(row.class_id) ?? 0) + 1);
  const nextDates = new Map<string, ClassDate>();
  for (const row of (eventRows ?? []) as (Parameters<typeof dateOf>[0] & { class_id: string })[]) {
    if (!nextDates.has(row.class_id)) nextDates.set(row.class_id, dateOf(row));
  }
  // Which of a family's children have already marked the prep on the next dates as done.
  const prepEventIds = [...nextDates.values()].filter((item) => item.requiresPrework).map((item) => item.id);
  const { data: completionRows } = prepEventIds.length && children.length
    ? await supabase.from("event_completions").select("event_id,child_id").in("event_id", prepEventIds).in("child_id", children.map((child) => child.id))
    : { data: [] };
  const completed = new Set(((completionRows ?? []) as { event_id: string; child_id: string }[]).map((row) => `${row.event_id}:${row.child_id}`));
  const files = new Map<string, number>();
  for (const row of (documentRows ?? []) as { class_id: string }[]) files.set(row.class_id, (files.get(row.class_id) ?? 0) + 1);
  const chats = new Map<string, string>((chatRows ?? []).map((row: { id: string; class_id: string }) => [row.class_id, row.id]));

  function card(raw: RawClass, role: TeachingRole | null, kids: Kid[]): ClassCardData {
    const next = nextDates.get(raw.id) ?? null;
    return {
      ...core(raw, today), role, kids,
      prepNeeded: !role && !!next?.requiresPrework && kids.some((kid) => !completed.has(`${next.id}:${kid.id}`)),
      teachers: teachersByClass.get(raw.id) ?? [],
      studentCount: role ? counts.get(raw.id) ?? 0 : null,
      nextDate: nextDates.get(raw.id) ?? null,
      fileCount: files.get(raw.id) ?? 0,
      chatId: chats.get(raw.id) ?? null,
    };
  }

  const teaching = assignments.map((row) => card(row.classes as RawClass, row.assignment_role, []));
  const byClass = new Map<string, { raw: RawClass; kids: Kid[] }>();
  for (const row of enrollments) {
    if (!row.classes) continue;
    const child = children.find((entry) => entry.id === row.child_id);
    if (!child) continue;
    const entry = byClass.get(row.class_id) ?? { raw: row.classes, kids: [] };
    entry.kids.push({ id: child.id, name: child.first_name });
    byClass.set(row.class_id, entry);
  }
  const family = [...byClass.values()].map(({ raw, kids }) => card(raw, null, kids));

  // This year's classes first, in the order they meet; earlier years after.
  const rank = (item: ClassCardData) => (isCurrent(item, currentYearId) ? 0 : 1);
  const sorter = (a: ClassCardData, b: ClassCardData) =>
    rank(a) - rank(b) || (a.nextMeeting ?? "9999").localeCompare(b.nextMeeting ?? "9999") || a.title.localeCompare(b.title);
  return { teaching: teaching.sort(sorter), family: family.sort(sorter), currentYearId };
}

/** This year's class, or one with no year recorded, that is still running. */
export function isCurrent(item: Pick<ClassCore, "schoolYearId" | "active" | "ended">, currentYearId: string | null) {
  if (!item.active || item.ended) return false;
  return !currentYearId || !item.schoolYearId || item.schoolYearId === currentYearId;
}

// --- the class page --------------------------------------------------------------------

export type Person = { id: string; name: string; avatarPath: string | null; grade: string | null };

export type DocumentRow = {
  id: string; title: string; kind: "handout" | "curriculum" | string; storagePath: string; createdAt: string; uploadedBy: string | null;
};

export type ClassPageData = {
  klass: ClassCore;
  /** How the person stands to this class. A person who is none of these is shown nothing. */
  isLead: boolean;
  isAssistant: boolean;
  isAdmin: boolean;
  /** Their own children enrolled here (any viewer). */
  kids: Kid[];
  teachers: Teacher[];
  /** Everyone enrolled; only ever more than the viewer's own children for teachers and admins. */
  roster: Person[];
  documents: DocumentRow[];
  dates: ClassDate[];
  completions: { eventId: string; childId: string }[];
  chatId: string | null;
};

export async function loadClassPage(supabase: SupabaseClient, userId: string, classId: string, roles: string[]): Promise<ClassPageData | null> {
  const today = new Date();
  const [{ data: classRow }, { data: teacherRows }, { data: enrollmentRows }, { data: membership }] = await Promise.all([
    supabase.from("classes").select(CLASS_FIELDS).eq("id", classId).maybeSingle(),
    supabase.from("teacher_assignments").select("class_id,assignment_role,user_id,profiles(display_name,email)").eq("class_id", classId),
    supabase.from("enrollments").select("child_id,children(id,first_name,last_name,age_band,avatar_path)").eq("class_id", classId).eq("status", "active"),
    supabase.from("family_members").select("family_id").eq("user_id", userId),
  ]);
  if (!classRow) return null;

  const allTeachers = ((teacherRows ?? []) as unknown as TeacherRow[]);
  const mine = allTeachers.find((row) => row.user_id === userId);
  const isAdmin = roles.includes("admin");

  const familyIds = (membership ?? []).map((row) => row.family_id as string);
  const { data: ownChildRows } = familyIds.length
    ? await supabase.from("children").select("id").in("family_id", familyIds)
    : { data: [] };
  const ownIds = new Set((ownChildRows ?? []).map((row) => row.id as string));

  const everyone = ((enrollmentRows ?? []) as unknown as { child_id: string; children: { id: string; first_name: string; last_name: string | null; age_band: string | null; avatar_path: string | null } | null }[])
    .flatMap((row) => row.children ? [row.children] : []);
  const kids = everyone.filter((child) => ownIds.has(child.id)).map((child) => ({ id: child.id, name: child.first_name }));

  // Not a teacher of it, not an administrator, and no child of theirs in it: nothing to show.
  if (!mine && !isAdmin && !kids.length) return null;

  const [{ data: documentRows }, { data: eventRows }, { data: chatRows }] = await Promise.all([
    supabase.from("documents").select("id,title,kind,storage_path,created_at,uploaded_by_user_id").eq("class_id", classId).order("created_at", { ascending: false }),
    supabase.from("events").select("id,title,description,location,starts_at,requires_prework").eq("class_id", classId).eq("audience", "class").order("starts_at"),
    supabase.from("conversations").select("id").eq("class_id", classId).limit(1),
  ]);
  const dates = ((eventRows ?? []) as Parameters<typeof dateOf>[0][]).map(dateOf);
  const preworkIds = dates.filter((item) => item.requiresPrework).map((item) => item.id);
  const { data: completionRows } = preworkIds.length && kids.length
    ? await supabase.from("event_completions").select("event_id,child_id").in("event_id", preworkIds).in("child_id", kids.map((kid) => kid.id))
    : { data: [] };

  // A parent is shown their own children and nobody else's, whatever else came back.
  const seesWholeClass = !!mine || isAdmin;
  const roster = (seesWholeClass ? everyone : everyone.filter((child) => ownIds.has(child.id)))
    .map((child) => ({ id: child.id, name: [child.first_name, child.last_name].filter(Boolean).join(" "), avatarPath: child.avatar_path, grade: child.age_band }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    klass: core(classRow as unknown as RawClass, today),
    isLead: mine?.assignment_role === "lead",
    isAssistant: mine?.assignment_role === "assistant",
    isAdmin,
    kids,
    teachers: allTeachers.map(teacherFromRow).filter((teacher) => teacher.name).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "lead" ? -1 : 1)),
    roster,
    documents: ((documentRows ?? []) as { id: string; title: string; kind: string; storage_path: string | null; created_at: string; uploaded_by_user_id: string | null }[])
      .filter((row) => row.storage_path)
      .map((row) => ({ id: row.id, title: row.title, kind: row.kind, storagePath: row.storage_path as string, createdAt: row.created_at, uploadedBy: row.uploaded_by_user_id })),
    dates,
    completions: ((completionRows ?? []) as { event_id: string; child_id: string }[]).map((row) => ({ eventId: row.event_id, childId: row.child_id })),
    chatId: (chatRows ?? [])[0]?.id ?? null,
  };
}

// --- actions that leave the page -----------------------------------------------------------

/** Opens (or returns) the one private thread between a teacher and a child's parents. */
export async function openChildThread(supabase: SupabaseClient, childId: string, teacherId?: string): Promise<{ href: string } | { error: string }> {
  const { data, error } = await supabase.rpc("start_child_conversation", teacherId ? { p_child_id: childId, p_teacher_id: teacherId } : { p_child_id: childId });
  if (error || typeof data !== "string") return { error: error?.message ?? "Could not open the conversation. Try again." };
  return { href: `/family-village/messages?c=${data}` };
}

/** Opens the class's message channel, creating it first when a teacher asks and none exists yet. */
export async function openClassChat(supabase: SupabaseClient, classId: string, existingId: string | null): Promise<{ href: string } | { error: string }> {
  if (existingId) return { href: `/family-village/messages?c=${existingId}` };
  const { data, error } = await supabase.rpc("open_class_conversation", { p_class_id: classId });
  if (error || typeof data !== "string") return { error: error?.message ?? "Could not open the class chat. Try again." };
  return { href: `/family-village/messages?c=${data}` };
}

export function classHref(id: string) { return `/family-village/classes/view?id=${id}`; }
