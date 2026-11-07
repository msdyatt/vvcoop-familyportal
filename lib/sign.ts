import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared vocabulary for in-portal signing. The rules live in the database
 * (sign_* functions); this file only names the shapes and turns the database's
 * answers into plain sentences.
 */

export type FieldKind = "signature" | "initials" | "date" | "text" | "checkbox";
export type SignRequestStatus = "sent" | "in_progress" | "signed" | "completed" | "voided";
export type SignerStatus = "pending" | "viewed" | "consented" | "signed";

export type SignRequest = {
  id: string;
  template_id: string;
  family_id: string | null;
  requirement_id: string | null;
  family_requirement_id: string | null;
  title: string;
  original_path: string;
  original_sha256: string;
  page_count: number;
  signing_order: "any" | "sequential";
  message: string | null;
  due_on: string | null;
  status: SignRequestStatus;
  created_at: string;
  sealed_path: string | null;
  sealed_at: string | null;
  seal_error: string | null;
  void_reason: string | null;
  document_id: string | null;
};

export type Mark = { kind: "typed"; text: string } | { kind: "drawn"; png: string };

export type SignSigner = {
  id: string;
  request_id: string;
  slot: 1 | 2;
  user_id: string | null;
  display_name: string;
  email: string | null;
  status: SignerStatus;
  viewed_at: string | null;
  consented_at: string | null;
  signed_at: string | null;
};

export type SignField = {
  id: string;
  template_id: string;
  page: number;
  /** Fractions of the page, from the top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: FieldKind;
  signer_slot: 1 | 2;
  required: boolean;
  label: string | null;
};

export type SignValue = { field_id: string; signer_id: string; value: string };

export const REQUEST_COLUMNS =
  "id,template_id,family_id,requirement_id,family_requirement_id,title,original_path,original_sha256,page_count,signing_order,message,due_on,status,created_at,sealed_path,sealed_at,seal_error,void_reason,document_id";
export const SIGNER_COLUMNS = "id,request_id,slot,user_id,display_name,email,status,viewed_at,consented_at,signed_at";
export const FIELD_COLUMNS = "id,template_id,page,x,y,w,h,kind,signer_slot,required,label";

/** The sentences behind the codes private.signing_blockers returns. */
export const BLOCKER_TEXT: Record<string, string> = {
  account_not_active: "Your account is not active yet. An administrator needs to finish setting it up.",
  invitation_not_accepted: "Your invitation has not been accepted yet. Open the invitation email and finish setting up your account.",
  profile_incomplete: "Your profile needs your name. Add it under Account & Security.",
};

export function blockerSentences(codes: string[]): string[] {
  return codes.map((code) => BLOCKER_TEXT[code] ?? "Your account is not ready to sign yet.");
}

export function requestStatusLabel(status: SignRequestStatus): string {
  return ({
    sent: "Waiting for signatures", in_progress: "Partly signed", signed: "Preparing the signed copy",
    completed: "Signed", voided: "Cancelled",
  } as Record<SignRequestStatus, string>)[status];
}

export function signerStatusLabel(status: SignerStatus): string {
  return ({ pending: "Not opened", viewed: "Opened", consented: "Agreed to sign", signed: "Signed" } as Record<SignerStatus, string>)[status];
}

export function statusTone(status: SignRequestStatus | SignerStatus): string {
  if (status === "completed" || status === "signed") return "signed";
  if (status === "voided") return "declined";
  if (status === "sent" || status === "viewed" || status === "consented" || status === "in_progress") return "sent";
  return "pending";
}

/** Database errors reach us as plain sentences; keep them, but never show a stack or a code. */
export function friendlyError(error: { message?: string; details?: string } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message || /^(permission denied|new row|duplicate key|invalid input)/i.test(message)) return "Something went wrong. Please try again.";
  return message;
}

export async function getEligibility(supabase: SupabaseClient): Promise<{ eligible: boolean; blockers: string[] }> {
  const { data, error } = await supabase.rpc("sign_eligibility");
  if (error || !data) return { eligible: false, blockers: ["account_not_active"] };
  return data as { eligible: boolean; blockers: string[] };
}

/** Asks the sealing function to finish a fully signed request. Safe to repeat. */
export async function requestSeal(supabase: SupabaseClient, requestId: string): Promise<{ ok: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke("esign-seal", { body: { requestId } });
  if (error) return { ok: false, message: "The signed copy could not be prepared yet." };
  const result = data as { ok?: boolean; error?: string } | null;
  return result?.ok ? { ok: true } : { ok: false, message: result?.error };
}

export function formatSignedAt(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
