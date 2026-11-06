import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";
import type { ReceiptData } from "./receipt-pdf.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatReceiptDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

export function methodLabel(p: { method: string | null; wallet: string | null; brand: string | null; last4: string | null; bank_name: string | null }): string {
  const wallet = p.wallet === "apple_pay" ? " via Apple Pay" : p.wallet === "google_pay" ? " via Google Pay" : "";
  switch (p.method) {
    case "card": return `${BRANDS[p.brand ?? ""] ?? "Card"}${p.last4 ? ` ending ${p.last4}` : ""}${wallet}`;
    case "us_bank_account": return `Bank transfer${p.bank_name ? ` from ${p.bank_name}` : ""}${p.last4 ? ` ending ${p.last4}` : ""}`;
    case "cash": return "Cash";
    case "check": return "Check";
    case "crowded": return "Crowded (paid before dues moved to Family Village)";
    default: return "Other";
  }
}

export function receiptNumber(p: { id: string; direction: string; receipt_no: number | null; occurred_at: string | null }): string {
  if (p.direction === "refund") return `VV-R-${p.id.slice(0, 8).toUpperCase()}`;
  if (p.receipt_no === null) return `VV-${p.id.slice(0, 8).toUpperCase()}`;
  const year = p.occurred_at ? new Date(p.occurred_at).getUTCFullYear() : new Date().getUTCFullYear();
  return `VV-${year}-${String(p.receipt_no).padStart(5, "0")}`;
}

/**
 * Reads everything a receipt shows, through the caller's own session so that row
 * level security decides who may have it. Returns null when the payment is not
 * visible to them or has not settled.
 */
export async function loadReceipt(client: SupabaseClient<any, "public", any>, paymentId: string): Promise<ReceiptData | null> {
  const { data: p } = await client.from("dues_payments")
    .select("id,direction,status,amount_cents,method,wallet,brand,last4,bank_name,receipt_no,occurred_at,livemode,note,reason,families(display_name),dues_charges(requirements(title),school_years(label))")
    .eq("id", paymentId).maybeSingle();
  if (!p || p.status !== "succeeded") return null;
  const { data: settings } = await client.from("billing_settings")
    .select("receipt_org_name,receipt_ein,receipt_address,receipt_note").eq("id", "dues").maybeSingle();

  // The joins are single rows, but the client types them loosely.
  const one = (value: any) => (Array.isArray(value) ? value[0] : value);
  const charge = one(p.dues_charges);
  const title = one(charge?.requirements)?.title ?? "Dues";
  const year = one(charge?.school_years)?.label;
  const when = p.occurred_at ?? new Date().toISOString();
  return {
    kind: p.direction === "refund" ? "refund" : "payment",
    orgName: settings?.receipt_org_name ?? "Veritas Village",
    orgEin: settings?.receipt_ein ?? null,
    orgAddress: settings?.receipt_address ?? null,
    footerNote: settings?.receipt_note ?? null,
    receiptNumber: receiptNumber(p),
    date: formatReceiptDate(when),
    household: one(p.families)?.display_name ?? "Household",
    description: `${title}${year ? ` (${year})` : ""}`,
    amount: formatCents(p.amount_cents),
    method: methodLabel(p),
    reference: p.direction === "refund" ? (p.reason ?? null) : (p.note ?? null),
    // Test-mode rows are marked so a rehearsal receipt cannot pass for a real one.
    testMode: p.livemode === false && p.method !== "cash" && p.method !== "check",
  };
}
