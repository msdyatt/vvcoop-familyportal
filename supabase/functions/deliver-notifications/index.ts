import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { getFromAddress, readVaultSecret, sendViaResend } from "../_shared/resend.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { parseAllowList, processDeliveries, type ClaimedDelivery, type Deps, type Outcome } from "../_shared/notification-delivery.ts";
import { resolveSmsProvider } from "../_shared/sms.ts";

/**
 * Sends the emails and texts the notification ladder has queued (public.notification_deliveries).
 *
 *   { mode: "process" } -- pg_cron, every minute while something is queued. No session; gated by
 *                          the same Vault shared secret deliver-emails and deliver-push use.
 *
 * The database does the thinking. claim_deliveries hands over only rows that are still owed
 * (not seen, not switched off, agreement still in force, number unchanged) and marks them as
 * being sent, so two overlapping runs can never send the same row. This function renders the
 * message, sends it through the existing Resend setup (the same From address and Vault key as
 * deliver-emails) or the texting provider, and reports each result back with finish_delivery.
 *
 * Texts: until a texting provider exists the stub is used and nothing is sent; those rows are
 * recorded as skipped, not failed, so no backlog builds up to be sent later.
 *
 * DELIVERY_ALLOWLIST (an environment variable, normally unset): a comma-separated list of
 * addresses and numbers. When set, everything else is skipped. For dry runs only.
 */

const MAX_PER_RUN = 300;
const BATCH = 100;

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const body = await req.json().catch(() => null) as { mode?: string } | null;
  if (body?.mode !== "process") return json({ error: "Unknown mode." }, 400);

  const secret = await readVaultSecret(admin, "EMAIL_DELIVERY_SECRET");
  if (!secret || !safeEqual(req.headers.get("x-delivery-secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);

  const [from, resendKey, { data: settings }] = await Promise.all([
    getFromAddress(admin),
    readVaultSecret(admin, "RESEND_API_KEY"),
    admin.from("notification_settings").select("sms_provider").eq("id", "ladder").maybeSingle(),
  ]);
  const emailConfigured = Boolean(from && resendKey);
  const smsKey = await readVaultSecret(admin, "SMS_PROVIDER_KEY");
  const sms = resolveSmsProvider((settings as { sms_provider?: string } | null)?.sms_provider, smsKey);

  // Emails stay queued (and age out after a day) until Resend is set up, rather than failing.
  const channels = emailConfigured ? ["email", "sms"] : ["sms"];

  const deps: Deps = {
    sms,
    allowList: parseAllowList(Deno.env.get("DELIVERY_ALLOWLIST")),
    sendEmail: async (row, message): Promise<Outcome> => {
      // The delivery id is the idempotency key: a retry of the same row can never send twice.
      const result = await sendViaResend(resendKey!, from!, row.destination, message.subject, message.html, { idempotencyKey: row.delivery_id });
      // Same audit trail as every other email this app sends.
      await admin.from("email_outbox").insert({
        recipient_email: row.destination, subject: message.subject, html_body: message.html,
        kind: row.kind, subject_type: "notification", subject_id: row.notification_id,
        status: result.ok ? "sent" : "failed", sent_at: result.ok ? new Date().toISOString() : null,
        error_detail: result.ok ? null : result.error.slice(0, 500),
      });
      return result.ok
        ? { status: "sent", provider: "resend", messageId: result.id }
        : { status: "failed", provider: "resend", error: result.error, retryable: result.retryable };
    },
    finish: async (row: ClaimedDelivery, outcome: Outcome) => {
      await admin.rpc("finish_delivery", {
        p_id: row.delivery_id, p_status: outcome.status,
        p_reason: outcome.status === "skipped" ? outcome.reason : null,
        p_provider: outcome.provider,
        p_message_id: outcome.status === "sent" ? outcome.messageId : null,
        p_error: outcome.status === "failed" ? outcome.error : null,
        p_retryable: outcome.status === "failed" ? outcome.retryable : true,
      });
    },
  };

  const total = { sent: 0, failed: 0, skipped: 0 };
  let handled = 0;
  while (handled < MAX_PER_RUN) {
    const { data: claimed, error } = await admin.rpc("claim_deliveries", { p_channels: channels, p_limit: BATCH });
    if (error) throw new Error(`claim_deliveries failed: ${error.message}`);
    const rows = (claimed ?? []) as ClaimedDelivery[];
    if (!rows.length) break;
    const tally = await processDeliveries(rows, deps);
    total.sent += tally.sent; total.failed += tally.failed; total.skipped += tally.skipped;
    handled += rows.length;
    if (rows.length < BATCH) break;
  }

  return json({ ok: true, ...total, emailConfigured, smsProvider: sms.name });
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
        await logEdgeError(admin, "deliver-notifications", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
