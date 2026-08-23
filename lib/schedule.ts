/**
 * How a class says when and where it meets.
 *
 * The time used to be free text on each class, which meant it could say "9",
 * "Fridays 11:00" or nothing at all, and two classes in the same slot had no way
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
  class_blocks: Pick<ClassBlock, "label" | "starts_at" | "ends_at"> | null;
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

/** "Block A · 9:00 – 10:15 AM" for a picker or a heading. */
export function formatBlock(block: Pick<ClassBlock, "label" | "starts_at" | "ends_at"> | null | undefined) {
  if (!block) return "";
  const time = formatBlockTime(block);
  return time ? `${block.label} · ${time}` : block.label;
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
export const SCHEDULE_SELECT = "class_blocks(label,starts_at,ends_at),rooms(name)";
