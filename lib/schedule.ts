/**
 * How a class says when and where it meets.
 *
 * The time used to be free text on each class, which meant it could say "9",
 * "Friday 11:00" or nothing at all, and two classes in the same slot had no way
 * to know they were in the same slot. Time now comes from a block -- a named
 * period of the co-op day, defined once with a real start and end -- so every
 * class in a block reports the same time by construction, and a clash is
 * something the database can actually see.
 */

export type ClassBlock = {
  id: string;
  label: string;
  /** Postgres `time`, e.g. "09:00:00". */
  starts_at: string;
  ends_at: string;
  sort_order: number;
  school_year_id: string | null;
  /** Postgres day number: Sunday 0 through Saturday 6. */
  day_of_week: number;
};

export type Room = {
  id: string;
  name: string;
  note: string | null;
  active: boolean;
  sort_order: number;
};

/** What a class embeds when it needs to show its schedule. */
export type ClassSchedule = {
  class_blocks: Pick<ClassBlock, "label" | "starts_at" | "ends_at" | "day_of_week"> | null;
  rooms: Pick<Room, "name"> | null;
};

/**
 * "09:00:00" to "9:00 AM".
 *
 * Built by hand rather than through toLocaleTimeString: a bare `time` has no
 * date, and wrapping one in a Date to format it drags the browser's timezone in
 * and shifts the answer. The same bug already cost this project a day over
 * date-only columns.
 */
export function formatTimeOfDay(value: string | null | undefined) {
  if (!value) return "";
  const [rawHour, rawMinute] = value.split(":");
  const hour = Number(rawHour);
  if (!Number.isFinite(hour)) return value;
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${rawMinute ?? "00"} ${suffix}`;
}

/** "9:00 – 10:15 AM", dropping the repeated meridiem when both sides share it. */
export function formatBlockTime(block: Pick<ClassBlock, "starts_at" | "ends_at"> | null | undefined) {
  if (!block) return "";
  const start = formatTimeOfDay(block.starts_at);
  const end = formatTimeOfDay(block.ends_at);
  if (!start || !end) return start || end;
  const [startClock, startSuffix] = start.split(" ");
  const [, endSuffix] = end.split(" ");
  return startSuffix === endSuffix ? `${startClock} – ${end}` : `${start} – ${end}`;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function formatWeekday(day: number | null | undefined) {
  return typeof day === "number" && day >= 0 && day < WEEKDAYS.length ? WEEKDAYS[day] : "Day not set";
}

/** "Friday · Block A · 9:00 – 10:15 AM" for a picker or heading. */
export function formatBlock(block: Pick<ClassBlock, "label" | "starts_at" | "ends_at" | "day_of_week"> | null | undefined) {
  if (!block) return "";
  const time = formatBlockTime(block);
  const label = [formatWeekday(block.day_of_week), block.label].filter(Boolean).join(" · ");
  return time ? `${label} · ${time}` : label;
}

/**
 * The one line a family or teacher reads: when, and which room.
 *
 * Returns the fallback rather than an empty string, because a blank where a time
 * should be reads as a rendering fault rather than as missing data.
 */
export function describeSchedule(row: Partial<ClassSchedule>, fallback = "Schedule to be announced") {
  const parts = [formatBlock(row.class_blocks), row.rooms?.name].filter(Boolean);
  return parts.length ? parts.join(" · ") : fallback;
}

/** The columns every schedule-aware select needs. Kept here so they cannot drift. */
export const SCHEDULE_SELECT = "class_blocks(label,starts_at,ends_at,day_of_week),rooms(name)";

/** A date-only value as "YYYY-MM-DD" in a plain calendar, with no timezone attached. */
function toDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The next day a weekly class meets, on or after `from`.
 *
 * A class meets on its block's weekday during its terms. A class with no term
 * assigned runs all year (the same convention the enrollment clash check uses),
 * and a class whose terms have all ended has no next meeting. The co-op has no
 * holiday calendar to subtract, so this is "the next scheduled day", not a
 * promise that nothing cancels it; a dated class event says what happens that day.
 *
 * Returns "YYYY-MM-DD", or null when the class has no weekday set or is over.
 */
export function nextMeetingDay(
  dayOfWeek: number | null | undefined,
  terms: { starts_on: string; ends_on: string }[],
  from: Date = new Date(),
): string | null {
  if (typeof dayOfWeek !== "number" || dayOfWeek < 0 || dayOfWeek > 6) return null;
  const today = toDay(from);
  const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  candidate.setDate(candidate.getDate() + ((dayOfWeek - candidate.getDay() + 7) % 7));
  if (!terms.length) return toDay(candidate);

  let best: string | null = null;
  for (const term of terms) {
    if (term.ends_on < today) continue;
    // The first meeting at or after the later of today and the term's start.
    const start = term.starts_on > today ? term.starts_on : today;
    const [year, month, day] = start.split("-").map(Number);
    const first = new Date(year, month - 1, day);
    first.setDate(first.getDate() + ((dayOfWeek - first.getDay() + 7) % 7));
    const found = toDay(first);
    if (found > term.ends_on) continue;
    if (best === null || found < best) best = found;
  }
  return best;
}

/** "Fri, Nov 13", from a "YYYY-MM-DD" day. */
export function formatDayShort(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
