/**
 * The date rules behind the compliance calendar, for the browser.
 *
 * The database generates the deadlines (migration 20261121090100_compliance_calendar.sql);
 * these mirror its date functions so the Compliance page can preview a custom deadline's
 * roll-forward and explain why a date moved. lib/compliance-dates.test.ts and pgTAP 036 check
 * the same cases, so the two cannot drift apart unnoticed.
 *
 * Dates are plain 'YYYY-MM-DD' strings, computed in UTC so no time zone can shift a day.
 */

export type IsoDate = string;

function parse(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

function make(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** The n-th weekday (0 = Sunday) of a month; n = -1 is the last one. */
export function nthWeekday(year: number, month: number, dow: number, n: number): IsoDate {
  if (n > 0) {
    const first = make(year, month, 1);
    return iso(addDays(first, ((dow - first.getUTCDay() + 7) % 7) + 7 * (n - 1)));
  }
  const last = make(year, month + 1, 0);
  return iso(addDays(last, -((last.getUTCDay() - dow + 7) % 7)));
}

/** A fixed-date holiday on a Saturday is observed on Friday; on a Sunday, on Monday. */
export function observedDay(date: IsoDate): IsoDate {
  const d = parse(date);
  const dow = d.getUTCDay();
  return iso(dow === 6 ? addDays(d, -1) : dow === 0 ? addDays(d, 1) : d);
}

/**
 * The legal holidays (observed days) the IRS treats as non-business days in a year: the
 * federal holidays plus DC Emancipation Day (16 April). Inauguration Day is not included.
 */
export function usLegalHolidays(year: number): IsoDate[] {
  const fixed = (month: number, day: number) => observedDay(iso(make(year, month, day)));
  const days = [
    fixed(1, 1),
    observedDay(iso(make(year + 1, 1, 1))),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    fixed(4, 16),
    nthWeekday(year, 5, 1, -1),
    ...(year >= 2021 ? [fixed(6, 19)] : []),
    fixed(7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2),
    fixed(11, 11),
    nthWeekday(year, 11, 4, 4),
    fixed(12, 25),
  ];
  return [...new Set(days.filter((d) => d.startsWith(`${year}-`)))].sort();
}

export function isBusinessDay(date: IsoDate): boolean {
  const dow = parse(date).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !usLegalHolidays(Number(date.slice(0, 4))).includes(date);
}

/** A due date on a weekend or legal holiday moves to the next business day. */
export function rollForward(date: IsoDate): IsoDate {
  let d = date;
  while (!isBusinessDay(d)) d = iso(addDays(parse(d), 1));
  return d;
}

/** Why a date would move, in words, or null if it stays. */
export function rollReason(date: IsoDate): string | null {
  const dow = parse(date).getUTCDay();
  if (dow === 6) return "a Saturday";
  if (dow === 0) return "a Sunday";
  if (usLegalHolidays(Number(date.slice(0, 4))).includes(date)) return "a legal holiday";
  return null;
}

/** The last day of a fiscal year ending in `month` of `year`. */
export function fiscalYearEnd(month: number, year: number): IsoDate {
  return iso(make(year, month + 1, 0));
}

/** The 15th day of the 5th month after the fiscal year ends (before any roll-forward). */
export function annualReturnDue(month: number, year: number): IsoDate {
  return iso(make(year, month + 5, 15));
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Monday, May 17, 2027", read in UTC so the date never shifts. */
export function longDate(date: IsoDate): string {
  return parse(date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}
