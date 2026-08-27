import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { readVaultSecret } from "../_shared/resend.ts";
import { safeEqual } from "../_shared/crypto.ts";

/**
 * The other end of the print_jobs queue: a Raspberry Pi wired to the office
 * printer (a Brother HL-L3300CDW) will eventually poll this to pick up
 * pending jobs and submit them over IPP/CUPS, then report back whether each
 * one actually printed. That script does not exist yet -- this function only
 * builds the API it will call against.
 *
 * No Supabase session exists on that end, so -- same fail-closed pattern as
 * opensign-webhook and deliver-emails's own "process" mode -- this is gated
 * by a shared secret (Vault: PRINT_DELIVERY_SECRET), not a user session.
 *
 * Two request shapes:
 *   { mode: "list" }                          -- atomically claims every
 *                                                 pending job (flips it to
 *                                                 "sending" so a second poll
 *                                                 before this one reports back
 *                                                 can't pick up and print the
 *                                                 same job twice) and returns
 *                                                 everything the printer needs.
 *                                                 A job carries exactly one of
 *                                                 two content forms: a
 *                                                 self-contained html_body (an
 *                                                 admin report, rendered by
 *                                                 this app) or a storage_path
 *                                                 (a teacher's uploaded file,
 *                                                 for the printer script to
 *                                                 download and hand to CUPS
 *                                                 directly) -- plus sides and
 *                                                 copies either way.
 *   { mode: "report", id, status, error? }    -- marks one claimed job
 *                                                 "printed" or "failed" once
 *                                                 the printer has actually
 *                                                 tried it.
 */

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const secret = await readVaultSecret(adminClient, "PRINT_DELIVERY_SECRET");
  const presented = req.headers.get("x-delivery-secret") ?? "";
  if (!secret || !safeEqual(presented, secret)) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null) as { mode?: string; id?: string; status?: string; error?: string } | null;

  if (body?.mode === "list") {
    // Claim-then-return in one round trip: an update with a select back is
    // atomic in Postgres, so two overlapping polls can't both claim the same
    // row the way a separate select-then-update would allow.
    const { data, error } = await adminClient.from("print_jobs")
      .update({ status: "sending" })
      .eq("status", "pending")
      .select("id,title,html_body,storage_path,duplex,orientation,sides,copies,printer_id,created_at")
      .order("created_at")
      .limit(20);
    if (error) return json({ error: error.message }, 500);

    // The Pi authenticates with the shared delivery secret above, not a
    // Supabase session -- it has no way to read a private-bucket file on its
    // own. For any job carrying storage_path (a teacher's upload) rather than
    // an inline html_body (an admin report), hand back a short-lived signed
    // URL instead, since that's the only credential this script gets.
    const jobs = data ?? [];
    const paths = jobs.map((job) => job.storage_path).filter((path): path is string => !!path);
    const signed = paths.length
      ? (await adminClient.storage.from("family-village-private").createSignedUrls(paths, 900)).data ?? []
      : [];
    const signedByPath = new Map(signed.filter((row) => row.signedUrl && !row.error && row.path).map((row) => [row.path as string, row.signedUrl]));
    const withUrls = jobs.map((job) => ({
      ...job,
      file_url: job.storage_path ? signedByPath.get(job.storage_path) ?? null : null,
    }));
    return json({ ok: true, jobs: withUrls });
  }

  if (body?.mode === "report") {
    const id = body.id?.trim();
    const status = body.status === "printed" || body.status === "failed" ? body.status : null;
    if (!id || !status) return json({ error: "A job id and a status of 'printed' or 'failed' are required." }, 400);
    const { error } = await adminClient.from("print_jobs").update({
      status, error_detail: status === "failed" ? (body.error?.slice(0, 500) ?? "The printer reported a failure.") : null,
      printed_at: status === "printed" ? new Date().toISOString() : null,
    }).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown mode." }, 400);
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
        await logEdgeError(adminClient, "printer-dispatch", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
