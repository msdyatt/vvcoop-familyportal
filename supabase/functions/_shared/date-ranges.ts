/**
 * Small pure helpers for "YYYY-MM-DD" date-only values, whose lexical order is
 * already chronological. Kept dependency-free and separate from index.ts so
 * they can be unit-tested without the edge runtime's npm imports.
 */

export type DateRange = { starts: string; ends: string };

/** Shifts a "YYYY-MM-DD" date by whole days, returning "YYYY-MM-DD". */
export function addDaysDateOnly(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Collapses date ranges into the fewest contiguous spans: ranges that overlap
 * or sit back-to-back with no gap merge into one, and a real gap between them
 * starts a new span.
 *
 * A class assigned to both a Fall and a Spring term produces two spans with
 * the winter break between them -- so a weekly recurrence built per span stops
 * for the break, instead of the class appearing to meet straight through it.
 */
export function mergeContiguousRanges(ranges: DateRange[]): DateRange[] {
  if (ranges.length <= 1) return ranges.map((range) => ({ ...range }));
  const sorted = [...ranges].sort((a, b) => (a.starts < b.starts ? -1 : a.starts > b.starts ? 1 : 0));
  const merged: DateRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.starts <= addDaysDateOnly(last.ends, 1)) {
      // Overlapping or exactly adjacent -- extend the current span.
      if (range.ends > last.ends) last.ends = range.ends;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
