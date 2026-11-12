/// <reference lib="deno.ns" />
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { formatCents, methodLabel, receiptNumber } from "./dues-receipt.ts";
import { buildReceiptPdf, type ReceiptData } from "./receipt-pdf.ts";

const base: ReceiptData = {
  kind: "payment", orgName: "Veritas Village", orgEin: "12-3456789", orgAddress: "123 Main St\nAustin, TX 78701", footerNote: "Thank you for being part of the Village.",
  receiptNumber: "VV-2026-00042", date: "September 2, 2026", household: "The Smith family", description: "Dues 2026-27 (2026-27)",
  amount: "$600.00", method: "Visa ending 4242 via Apple Pay", reference: null, testMode: false,
};

function text(bytes: Uint8Array) { return new TextDecoder("latin1").decode(bytes); }

Deno.test("buildReceiptPdf: a well-formed one-page PDF with the receipt facts and a valid cross-reference table", () => {
  const out = text(buildReceiptPdf(base));
  assert(out.startsWith("%PDF-1.4"));
  assert(out.trimEnd().endsWith("%%EOF"));
  for (const expected of ["Payment receipt", "VV-2026-00042", "The Smith family", "$600.00", "Visa ending 4242 via Apple Pay", "EIN 12-3456789", "Thank you for being part"]) {
    assertStringIncludes(out, expected);
  }
  // startxref must point at the "xref" keyword, and each entry at its "N 0 obj".
  const startxref = Number(/startxref\n(\d+)/.exec(out)![1]);
  assertEquals(out.slice(startxref, startxref + 4), "xref");
  const entries = [...out.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  assertEquals(entries.length, 9);
  entries.forEach((offset, index) => assertEquals(out.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`));
});

Deno.test("buildReceiptPdf: escapes text that would break the file and marks test-mode receipts", () => {
  const out = text(buildReceiptPdf({ ...base, household: "The (O'Brien) \\ family – “quoted” 日本", testMode: true, kind: "refund" }));
  assertStringIncludes(out, "(The \\(O'Brien\\) \\\\ family - \"quoted\" ??)");
  assertStringIncludes(out, "TEST MODE");
  assertStringIncludes(out, "Refund confirmation");
});

Deno.test("receipt wording helpers", () => {
  assertEquals(formatCents(123456), "$1,234.56");
  assertEquals(formatCents(5), "$0.05");
  assertEquals(methodLabel({ method: "us_bank_account", wallet: null, brand: null, last4: "6789", bank_name: "Test Bank" }), "Bank transfer from Test Bank ending 6789");
  assertEquals(methodLabel({ method: "card", wallet: "google_pay", brand: "mastercard", last4: "4444", bank_name: null }), "Mastercard ending 4444 via Google Pay");
  assertEquals(methodLabel({ method: "check", wallet: null, brand: null, last4: null, bank_name: null }), "Check");
  assertEquals(receiptNumber({ id: "abcdef12-0000", direction: "charge", receipt_no: 7, occurred_at: "2026-09-02T15:00:00Z" }), "VV-2026-00007");
  assertEquals(receiptNumber({ id: "abcdef12-0000", direction: "refund", receipt_no: null, occurred_at: null }), "VV-R-ABCDEF12");
});
