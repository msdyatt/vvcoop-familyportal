/**
 * Date handling for the calendar views.
 *
 * One rule matters more than the rest: an all-day event is stored as UTC
 * midnight (the database says so), so its *date* must be read in UTC, while a
 * timed event's date is the viewer's local one. Everything here goes through
 * `eventDays` so no view has to remember that.
 */

export type CalEvent = {
  id: string; title: string; description: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean;
  location: string | null; class_id: string | null; audience: string;
  classes?: { title: string } | null;
};

export type CalView = "month" | "week" | "day" | "list";

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-06" for a local date. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local Date at noon for a "YYYY-MM-DD" key (noon keeps DST shifts from changing the day). */
export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);
  return next;
}

export function startOfWeek(date: Date, weekStart = 0): Date {
  return addDays(date, -((date.getDay() - weekStart + 7) % 7));
}

/** The weeks of a month as rows of 7 local dates, padded with neighbouring days. */
export function monthGrid(year: number, month: number, weekStart = 0): Date[][] {
  const first = new Date(year, month, 1, 12);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const start = addDays(first, -offset);
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}

const utcKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Every date (as a "YYYY-MM-DD" key) an event touches. Spans are capped so bad data cannot run away. */
export function eventDays(event: Pick<CalEvent, "starts_at" | "ends_at" | "all_day">): string[] {
  const startKey = event.all_day ? utcKey(event.starts_at) : dayKey(new Date(event.starts_at));
  let endKey = startKey;
  if (event.ends_at) {
    // A timed event that ends exactly at midnight belongs to the day before.
    const end = new Date(new Date(event.ends_at).getTime() - (event.all_day ? 0 : 1));
    const candidate = event.all_day ? utcKey(event.ends_at) : dayKey(end);
    if (candidate > startKey) endKey = candidate;
  }
  const days: string[] = [];
  for (let d = fromKey(startKey), i = 0; dayKey(d) <= endKey && i < 31; d = addDays(d, 1), i++) days.push(dayKey(d));
  return days;
}

/** Events grouped by date, all-day first and then by start time. */
export function eventsByDay(events: CalEvent[]): Map<string, CalEvent[]> {
  const map = new Map<string, CalEvent[]>();
  for (const event of events) {
    for (const key of eventDays(event)) {
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title));
  }
  return map;
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "All day", "10:00 AM", or "10:00 AM – 11:30 AM". */
export function whenLabel(event: Pick<CalEvent, "starts_at" | "ends_at" | "all_day">): string {
  if (event.all_day) return "All day";
  return event.ends_at ? `${timeLabel(event.starts_at)} – ${timeLabel(event.ends_at)}` : timeLabel(event.starts_at);
}

/** A full date line for the detail sheet. Multi-day events show their span. */
export function dateLabel(event: Pick<CalEvent, "starts_at" | "ends_at" | "all_day">): string {
  const days = eventDays(event);
  const fmt = (key: string) => fromKey(key).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return days.length > 1 ? `${fmt(days[0])} to ${fmt(days[days.length - 1])}` : fmt(days[0]);
}

/** Minutes after local midnight, clamped to the given day, for placing a timed event on the day grid. */
export function minutesOnDay(iso: string, key: string): number {
  const d = new Date(iso);
  const day = dayKey(d);
  if (day < key) return 0;
  if (day > key) return 24 * 60;
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Lays timed events out side by side where they overlap, as a day grid needs.
 * Returns each event with a lane index and the number of lanes in its group.
 */
export function layoutLanes<T extends { startMin: number; endMin: number }>(items: T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: (T & { lane: number; lanes: number })[] = [];
  let group: (T & { lane: number; lanes: number })[] = [];
  let groupEnd = -1;
  const closeGroup = () => { const lanes = Math.max(1, ...group.map((g) => g.lane + 1)); group.forEach((g) => { g.lanes = lanes; }); placed.push(...group); group = []; };
  for (const item of sorted) {
    if (group.length && item.startMin >= groupEnd) { closeGroup(); groupEnd = -1; }
    const used = new Set(group.filter((g) => g.endMin > item.startMin).map((g) => g.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    group.push({ ...item, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  if (group.length) closeGroup();
  return placed;
}
