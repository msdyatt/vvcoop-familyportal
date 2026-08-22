/**
 * Shared vocabulary for family compliance -- required documents and dues.
 *
 * Both portals read the same rows, so the types and the presentation rules live
 * here rather than being restated in the family view and the admin matrix.
 */

export type RequirementKind = "document" | "dues";
export type ComplianceStatus = "outstanding" | "sent" | "complete" | "waived";

export type Requirement = {
  id: string;
  school_year_id: string;
  kind: RequirementKind;
  title: string;
  description: string | null;
  active: boolean;
  sort_order: number;
  document_id: string | null;
  /** OpenSign public template link, shared by every family. */
  public_sign_url: string | null;
  amount_per_family: number | null;
  amount_per_child: number | null;
  payment_url: string | null;
  due_on: string | null;
};

export type FamilyRequirement = {
  id: string;
  requirement_id: string;
  family_id: string;
  status: ComplianceStatus;
  signed_document_id: string | null;
  signed_at: string | null;
  signing_url: string | null;
  provider_document_id: string | null;
  amount_due: number | null;
  amount_paid: number;
  paid_at: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  note: string | null;
};

export type SchoolYear = {
  id: string;
  label: string;
  starts_on: string | null;
  ends_on: string | null;
  is_current: boolean;
};

/** `waived` counts as settled -- an administrator has decided it doesn't apply. */
export function isSettled(status: ComplianceStatus) {
  return status === "complete" || status === "waived";
}

export function outstandingCount(rows: Pick<FamilyRequirement, "status">[]) {
  return rows.filter((row) => !isSettled(row.status)).length;
}

/**
 * The label shown on a status pill. Deliberately says what is true of the item
 * rather than echoing the raw enum -- "Not signed" reads as a state a person
 * needs to act on; "outstanding" reads as jargon.
 */
export function statusLabel(kind: RequirementKind, row: Pick<FamilyRequirement, "status" | "signed_at" | "paid_at">) {
  if (row.status === "waived") return "Not required";
  if (row.status === "complete") {
    const when = kind === "dues" ? row.paid_at : row.signed_at;
    const verb = kind === "dues" ? "Paid" : "Signed";
    return when ? `${verb} ${formatDate(when)}` : verb;
  }
  if (row.status === "sent") return kind === "dues" ? "Awaiting payment" : "Awaiting signature";
  return kind === "dues" ? "Unpaid" : "Not signed";
}

/** Maps onto the .status-pill modifier classes in globals.css. */
export function statusTone(status: ComplianceStatus): "complete" | "waived" | "pending" | "outstanding" {
  if (status === "complete") return "complete";
  if (status === "waived") return "waived";
  if (status === "sent") return "pending";
  return "outstanding";
}

/**
 * Both formatters pin their locale and time zone on purpose.
 *
 * Passing `undefined` lets the runtime pick, which produces different output on
 * the server than in the browser and trips React's hydration check. It is also
 * wrong in a subtler way: a date-only column like `2026-09-15` parses as UTC
 * midnight, so rendering it in Central Time would show 14 September. Formatting
 * in UTC keeps a due date on the day it was actually set.
 */
export function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export function formatMoney(amount: number | null) {
  if (amount === null || Number.isNaN(amount)) return "—";
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

/**
 * What a family owes for a dues requirement.
 *
 * Captured once when the requirement is opened rather than derived on every
 * read, so enrolling another child mid-year cannot quietly change a figure a
 * family has already been shown. Administrators recalculate on purpose.
 */
export function duesFor(requirement: Requirement, activeChildren: number) {
  const perFamily = Number(requirement.amount_per_family ?? 0);
  const perChild = Number(requirement.amount_per_child ?? 0);
  return perFamily + perChild * activeChildren;
}
