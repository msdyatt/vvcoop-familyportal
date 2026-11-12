/**
 * Time in the co-op's own time zone.
 *
 * "Publish at 8:00 AM" means 8:00 in Central time, wherever the administrator's laptop thinks it
 * is, and it has to stay 8:00 across the daylight-saving change. The database stores a real
 * instant (UTC); this file turns a wall-clock date and time in the co-op's zone into that instant
 * and back. Same method as `localToUtcIso` in supabase/functions/calendar-feed/index.ts.
 *
 * Two clock quirks, handled the same way everywhere: a wall-clock time that does not exist (2:30 AM
 * on the night clocks spring forward) lands an hour later, and one that happens twice (1:30 AM when
 * they fall back) means the first time. Nobody schedules an announcement for those minutes on purpose.
 */

export const COOP_TZ = "America/Chicago";

/** How far a zone is ahead of UTC at a given instant, in minutes (Chicago is -300 in summer, -360 in winter). */
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000;
}

/** A wall-clock "YYYY-MM-DD" and "HH:MM" in the co-op's zone, as the real instant. Null if either is malformed. */
export function coopWallTimeToDate(date: string, time: string, timeZone: string = COOP_TZ): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [year, month, day, hour, minute] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null; // 31 November and the like
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset near the guess gives one candidate; the offset at that candidate gives another when a clock
  // change falls between them. Take the earliest candidate that reads back as the wall time asked for. If none does
  // (the time falls in the hour that is skipped), take the later one, which is the same minute an hour on.
  const first = offsetMinutes(timeZone, new Date(guess));
  const candidates = [guess - first * 60000];
  const second = offsetMinutes(timeZone, new Date(candidates[0]));
  if (second !== first) candidates.push(guess - second * 60000);
  candidates.sort((a, b) => a - b);
  const wanted = `${date} ${time}`;
  const exact = candidates.find((c) => { const w = coopWallTime(new Date(c), timeZone); return `${w.date} ${w.time}` === wanted; });
  return new Date(exact ?? candidates[candidates.length - 1]);
}

/** The co-op wall-clock date ("YYYY-MM-DD") and time ("HH:MM") of an instant, for filling the date and time boxes. */
export function coopWallTime(instant: Date | string, timeZone: string = COOP_TZ): { date: string; time: string } {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "Thu, Nov 19 at 8:00 AM CST" -- how a scheduled time reads on screen, always in the co-op's zone. */
export function formatCoopDateTime(instant: Date | string, timeZone: string = COOP_TZ): string {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  const day = at.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const time = at.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${day} at ${time}`;
}

/** The date a day is, plus a number of days, as "YYYY-MM-DD" (pure calendar arithmetic, no zone involved). */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
