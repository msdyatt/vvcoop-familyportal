/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { annualReturnDue, daysBetween, fiscalYearEnd, isBusinessDay, nthWeekday, rollForward, rollReason, usLegalHolidays } from "./compliance-dates.ts";

// The same cases as supabase/tests/database/036_compliance_calendar.test.sql.
Deno.test("weekend due dates move to Monday", () => {
  assertEquals(rollForward("2026-05-15"), "2026-05-15"); // Friday stays
  assertEquals(rollForward("2027-05-15"), "2027-05-17"); // Saturday
  assertEquals(rollForward("2027-01-31"), "2027-02-01"); // Sunday
  assertEquals(rollForward("2026-01-31"), "2026-02-02"); // Saturday 31 January
});

Deno.test("legal holidays move a due date to the next business day", () => {
  assertEquals(rollForward("2027-05-31"), "2027-06-01"); // Memorial Day
  assertEquals(rollForward("2027-06-18"), "2027-06-21"); // Juneteenth observed on Friday
  assertEquals(rollForward("2027-12-31"), "2028-01-03"); // New Year's Day 2028 observed on 31 December
  assertEquals(rollForward("2028-04-15"), "2028-04-18"); // Saturday, then DC Emancipation Day observed Monday
  assertEquals(rollForward("2022-04-15"), "2022-04-18"); // Emancipation Day observed Friday 15 April
  assertEquals(rollForward("2027-02-15"), "2027-02-16"); // Washington's Birthday
  assertEquals(rollForward("2026-11-26"), "2026-11-27"); // Thanksgiving
});

Deno.test("the holiday list per year", () => {
  assertEquals(usLegalHolidays(2026).length, 12);
  assertEquals(usLegalHolidays(2027).length, 13);
  assertEquals(usLegalHolidays(2028).length, 11);
  assertEquals(usLegalHolidays(2026).includes("2026-07-03"), true); // 4 July on a Saturday
  assertEquals(usLegalHolidays(2027).includes("2027-12-31"), true);
  assertEquals(nthWeekday(2026, 11, 4, 4), "2026-11-26");
  assertEquals(nthWeekday(2027, 5, 1, -1), "2027-05-31");
  assertEquals(isBusinessDay("2026-11-23"), true);
});

Deno.test("the annual return is due on the 15th day of the 5th month after the year ends", () => {
  assertEquals(annualReturnDue(12, 2026), "2027-05-15");
  assertEquals(annualReturnDue(6, 2026), "2026-11-15");
  assertEquals(rollForward(annualReturnDue(6, 2026)), "2026-11-16");
  assertEquals(annualReturnDue(8, 2026), "2027-01-15");
  assertEquals(rollForward(annualReturnDue(9, 2026)), "2027-02-16");
  assertEquals(fiscalYearEnd(2, 2028), "2028-02-29");
  assertEquals(fiscalYearEnd(12, 2026), "2026-12-31");
});

Deno.test("reasons and day counts", () => {
  assertEquals(rollReason("2027-05-15"), "a Saturday");
  assertEquals(rollReason("2027-01-31"), "a Sunday");
  assertEquals(rollReason("2027-05-31"), "a legal holiday");
  assertEquals(rollReason("2027-05-17"), null);
  assertEquals(daysBetween("2026-11-21", "2027-01-20"), 60);
});
