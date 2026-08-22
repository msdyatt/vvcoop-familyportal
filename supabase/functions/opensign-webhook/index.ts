import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { extractDocumentId, mapStatus } from "../_shared/opensign.ts";

/**
 * Receives OpenSign completion callbacks and moves the matching rows in
 * public.documents and public.signature_requests.
 *
 * This runs with verify_jwt = false, because OpenSign calls it directly and has
 * no Supabase session. Authentication is instead a shared secret compared in
 * constant time: set OPENSIGN_WEBHOOK_SECRET and give OpenSign the URL with
 * `?token=<secret>`, or have it send an `x-opensign-webhook-secret` header.
 *
 * Without the secret set the function refuses every request rather than
 * defaulting open -- an unauthenticated endpoint that can flip a waiver to
 * "signed" is not something to leave ajar.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time comparison, so a wrong secret cannot be found byte by byte. */
function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export default {
  async fetch(req: Request) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const secret = Deno.env.get("OPENSIGN_WEBHOOK_SECRET");
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
    if (!secret) return json({ error: "Webhook secret not configured" }, 503);

    const presented = new URL(req.url).searchParams.get("token")
      ?? req.headers.get("x-opensign-webhook-secret")
      ?? "";
    if (!safeEqual(presented, secret)) return json({ error: "Unauthorized" }, 401);

    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") return json({ error: "Expected a JSON body" }, 400);
    const record = payload as Record<string, unknown>;

    const providerDocumentId = extractDocumentId(record);
    if (!providerDocumentId) return json({ error: "No document id in payload" }, 400);

    const rawStatus = readString(record, ["event", "type", "status", "documentStatus"]);
    const status = mapStatus(rawStatus);
    const signerEmail = readString(record, ["email", "signerEmail"])?.toLowerCase() ?? null;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    if (!status) {
      // Acknowledge so OpenSign stops retrying, but leave a trace instead of
      // guessing at a state we do not recognise.
      await adminClient.from("signature_requests")
        .update({ error_detail: `Unrecognised webhook event: ${rawStatus ?? "(none)"}`.slice(0, 500) })
        .eq("provider_document_id", providerDocumentId);
      return json({ ok: true, ignored: rawStatus });
    }

    const completed = status === "signed" || status === "declined" || status === "expired";

    let query = adminClient.from("signature_requests")
      .update({ status, error_detail: null, ...(completed ? { completed_at: new Date().toISOString() } : {}) })
      .eq("provider_document_id", providerDocumentId);
    // A per-signer event moves only that signer; a document-level event moves all.
    if (signerEmail) query = query.eq("signer_email", signerEmail);
    const { error: updateError } = await query;
    if (updateError) return json({ error: updateError.message }, 500);

    // The document is only settled once no request is still outstanding.
    const { data: remaining } = await adminClient
      .from("signature_requests")
      .select("status")
      .eq("provider_document_id", providerDocumentId);

    const states = (remaining ?? []).map((row) => row.status);
    const documentStatus = states.length && states.every((s) => s === "signed")
      ? "signed"
      : states.includes("declined") ? "declined"
      : states.includes("expired") ? "expired"
      : "sent";

    await adminClient.from("documents")
      .update({ signature_status: documentStatus, updated_at: new Date().toISOString() })
      .eq("provider_document_id", providerDocumentId);

    return json({ ok: true, status, documentStatus });
  },
};
