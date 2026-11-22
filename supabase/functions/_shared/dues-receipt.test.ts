/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { formatReceiptDate, isTestReceipt, receiptNumber } from "./dues-receipt.ts";

const payment = (occurred_at: string | null) => ({ id: "0a1b2c3d-0000-0000-0000-000000000000", direction: "charge", receipt_no: 42, occurred_at });

Deno.test("receipt number: the year is the co-op's (Central), matching the printed date (#208)", () => {
  // 7pm Central on New Year's Eve is already January 1 in UTC.
  const nye = "2027-01-01T01:00:00Z";
  assertEquals(formatReceiptDate(nye), "December 31, 2026");
  assertEquals(receiptNumber(payment(nye)), "VV-2026-00042");
  assertEquals(receiptNumber(payment("2027-01-01T06:30:00Z")), "VV-2027-00042", "after midnight Central it is the new year");
  assertEquals(receiptNumber(payment(null), new Date("2027-01-01T02:00:00Z")), "VV-2026-00042", "no payment time: today in Central");
});

Deno.test("receipt number: refunds and unnumbered payments keep their id-based numbers", () => {
  assertEquals(receiptNumber({ ...payment(null), direction: "refund" }), "VV-R-0A1B2C3D");
  assertEquals(receiptNumber({ ...payment(null), receipt_no: null }), "VV-0A1B2C3D");
});

Deno.test("receipts: only Stripe test-mode payments are marked as tests, never money recorded by hand (#170)", () => {
  assertEquals(isTestReceipt({ livemode: false, method: "card" }), true);
  assertEquals(isTestReceipt({ livemode: false, method: "us_bank_account" }), true);
  for (const method of ["cash", "check", "crowded", "other"]) assertEquals(isTestReceipt({ livemode: false, method }), false, method);
  assertEquals(isTestReceipt({ livemode: true, method: "card" }), false);
});
