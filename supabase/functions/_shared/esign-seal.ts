import type { AdminClient } from "./types.ts";
import type { TimestampResult } from "./rfc3161.ts";
import {
  appendCertificate, flattenSigned, sha256Hex,
  type SealEvent, type SealField, type SealRecord, type SealRequest, type SealSigner, type SealValue, type TimestampInfo,
} from "./esign-pdf.ts";

export const PRIVATE_BUCKET = "family-village-private";

/**
 * Everything sealing needs from the outside world. The edge function backs this
 * with Supabase; the tests back it with memory, so the sealing logic runs end to
 * end against a throwaway PDF with no network.
 */
export interface SealStore {
  getRequest(id: string): Promise<SealRequest | null>;
  claim(id: string): Promise<boolean>;
  loadRecord(id: string): Promise<SealRecord>;
  download(path: string): Promise<Uint8Array>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  complete(id: string, sealedSha256: string, bodySha256: string): Promise<void>;
  fail(id: string, message: string): Promise<void>;
  /** Called after the sealed file is stored, with the hashes, so a timestamp can be attached. */
  logTimestamp?(id: string, detail: Record<string, unknown>): Promise<void>;
}

/** Asks an independent time-stamping authority (RFC 3161) to time-stamp a SHA-256 value. */
export type Timestamper = (sha256Hex: string) => Promise<TimestampResult>;
export type TimestampSetup = { authority: string; stamp: Timestamper };

export type SealOutcome =
  | { ok: true; status: "completed"; sealedSha256: string; bodySha256: string; alreadySealed: boolean }
  | { ok: false; status: "not_ready" | "busy" | "failed"; message: string };

export const bodyPath = (id: string) => `sign/requests/${id}/signed-content.pdf`;
export const sealedPath = (id: string) => `sign/requests/${id}/sealed.pdf`;
/** Timestamp over the signed content (printed on the certificate). Verify against signed-content.pdf. */
export const tokenPath = (id: string) => `sign/requests/${id}/content-timestamp.tsr`;
/** Timestamp over the final sealed PDF, certificate page included. Verify against sealed.pdf. */
export const sealedTokenPath = (id: string) => `sign/requests/${id}/sealed-timestamp.tsr`;

/**
 * Seals a fully signed request: re-checks the stored original against the hash
 * it was sent with, places every entry on the pages, appends the certificate,
 * stores both files, and tells the database. Safe to call again: a completed
 * request returns what it already has, and a claim that is already held (by a
 * call still running) makes this one step aside.
 */
export async function sealRequest(store: SealStore, requestId: string, timestamp?: TimestampSetup): Promise<SealOutcome> {
  const req = await store.getRequest(requestId);
  if (!req) return { ok: false, status: "not_ready", message: "That request does not exist." };
  if (req.status === "completed" && req.sealed_sha256) {
    return { ok: true, status: "completed", sealedSha256: req.sealed_sha256, bodySha256: "", alreadySealed: true };
  }
  if (req.status !== "signed") {
    return { ok: false, status: "not_ready", message: "Not everyone has signed yet." };
  }
  if (!(await store.claim(requestId))) {
    return { ok: false, status: "busy", message: "This is already being sealed." };
  }

  try {
    const original = await store.download(req.original_path);
    const actual = await sha256Hex(original);
    if (actual !== req.original_sha256) {
      throw new Error(`The stored original no longer matches the file that was sent (expected ${req.original_sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…).`);
    }

    const record = await store.loadRecord(requestId);
    if (record.signers.length === 0 || record.signers.some((s) => s.status !== "signed")) {
      throw new Error("A signer has not finished.");
    }
    // Every signature, initials and date field must have its value before anything
    // is drawn. Fields for a slot nobody was asked to sign (a one-adult household
    // sent a two-signer document) are left off.
    const have = new Set(record.values.map((v) => v.field_id));
    const slots = new Set(record.signers.map((s) => s.slot));
    const missing = record.fields.filter((f) => slots.has(f.signer_slot) && f.kind !== "text" && f.kind !== "checkbox" && !have.has(f.id));
    if (missing.length > 0) throw new Error(`${missing.length} field(s) have no recorded value.`);

    const body = await flattenSigned(original, record, req.title);
    const bodySha256 = await sha256Hex(body);

    // The certificate page prints the first timestamp, so it has to exist before
    // the page is drawn. That is why it covers the signed content (everything but
    // the certificate) and not the finished file: a file cannot contain a timestamp
    // of itself. If an authority is configured and does not answer, sealing stops
    // and can be retried; the signatures are already safe in the database.
    let first: TimestampResult | null = null;
    let info: TimestampInfo | null = null;
    if (timestamp) {
      first = await timestamp.stamp(bodySha256);
      info = {
        authority: timestamp.authority, genTime: first.genTime, serial: first.serial,
        digestAlgorithm: first.digestAlgorithm, imprintHex: first.imprintHex,
        covers: "the signed content: the original pages with every entry placed on them, before this page was added",
      };
    }

    const sealedAt = new Date();
    const sealed = await appendCertificate(body, req, record, { bodySha256, sealedAt, timestamp: info });
    const sealedSha256 = await sha256Hex(sealed);

    // A second timestamp over the finished file, so the whole PDF can be checked
    // too. Best effort: the first already carries the evidence that matters.
    let second: TimestampResult | null = null;
    let secondError: string | null = null;
    if (timestamp) {
      try { second = await timestamp.stamp(sealedSha256); } catch (error) { secondError = error instanceof Error ? error.message : String(error); }
    }

    await store.upload(bodyPath(requestId), body);
    if (first) await store.upload(tokenPath(requestId), first.response);
    await store.upload(sealedPath(requestId), sealed);
    if (second) await store.upload(sealedTokenPath(requestId), second.response);
    await store.complete(requestId, sealedSha256, bodySha256);
    if (timestamp && store.logTimestamp) {
      const base = { authority: timestamp.authority, standard: "RFC 3161" };
      if (first) await store.logTimestamp(requestId, { ...base, covers: "signed-content", sha256: bodySha256, gen_time: first.genTime, serial: first.serial, policy: first.policy });
      if (second) await store.logTimestamp(requestId, { ...base, covers: "sealed", sha256: sealedSha256, gen_time: second.genTime, serial: second.serial, policy: second.policy });
      else if (secondError) await store.logTimestamp(requestId, { ...base, covers: "sealed", sha256: sealedSha256, error: secondError });
    }
    return { ok: true, status: "completed", sealedSha256, bodySha256, alreadySealed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.fail(requestId, message).catch(() => undefined);
    return { ok: false, status: "failed", message };
  }
}

/** The real thing: Supabase, with a service-role client. */
export function supabaseSealStore(admin: AdminClient): SealStore {
  const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data as T;
  };
  return {
    async getRequest(id) {
      const r = await admin.from("sign_requests")
        .select("id,title,status,original_path,original_sha256,page_count,template_id,signing_order,sealed_sha256,document_id")
        .eq("id", id).maybeSingle();
      return must(r, "request") as SealRequest | null;
    },
    async claim(id) {
      const r = await admin.rpc("sign_claim_seal", { p_request: id });
      return must(r, "claim") === true;
    },
    async loadRecord(id) {
      const req = must(await admin.from("sign_requests").select("template_id").eq("id", id).single(), "request") as { template_id: string };
      const [signers, fields, values, events] = await Promise.all([
        admin.from("sign_signers").select("id,slot,display_name,email,status,consented_at,consent_text_sha256,signed_at,signature,initials").eq("request_id", id).order("slot"),
        admin.from("sign_fields").select("id,page,x,y,w,h,kind,signer_slot,label").eq("template_id", req.template_id),
        admin.from("sign_field_values").select("field_id,signer_id,value").eq("request_id", id),
        admin.from("sign_events").select("id,signer_id,action,actor_name,ip,user_agent,detail,created_at").eq("request_id", id).order("id"),
      ]);
      return {
        signers: must(signers, "signers") as SealSigner[],
        fields: must(fields, "fields") as SealField[],
        values: must(values, "values") as SealValue[],
        events: must(events, "events") as SealEvent[],
      };
    },
    async download(path) {
      const r = await admin.storage.from(PRIVATE_BUCKET).download(path);
      if (r.error || !r.data) throw new Error(`download ${path}: ${r.error?.message ?? "empty"}`);
      return new Uint8Array(await r.data.arrayBuffer());
    },
    async upload(path, bytes) {
      const r = await admin.storage.from(PRIVATE_BUCKET).upload(path, bytes, { contentType: path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".tsr") ? "application/timestamp-reply" : "application/octet-stream", upsert: true });
      if (r.error) throw new Error(`upload ${path}: ${r.error.message}`);
    },
    async complete(id, sealedSha256, bodySha256) {
      const r = await admin.rpc("sign_complete", { p_request: id, p_sealed_sha256: sealedSha256, p_body_sha256: bodySha256 });
      if (r.error) throw new Error(`complete: ${r.error.message}`);
    },
    async fail(id, message) {
      await admin.rpc("sign_mark_seal_failed", { p_request: id, p_error: message });
    },
    async logTimestamp(id, detail) {
      await admin.rpc("sign_log_timestamp", { p_request: id, p_detail: detail });
    },
  };
}
