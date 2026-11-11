import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";
import webpush from "npm:web-push@3.6.7";
import { logEdgeError } from "../_shared/error-log.ts";
import { readVaultSecret } from "../_shared/resend.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { withOpenMarker } from "../_shared/paths.ts";
import { decidePush, type Access } from "../_shared/push-plan.ts";
import { sendFcm, type ServiceAccount } from "../_shared/fcm.ts";
import { corsHeaders, json } from "../_shared/http.ts";

/**
 * Sends web push for rows in public.notifications.
 *
 *   { mode: "public-key" } -- returns the VAPID public key the browser needs
 *                             to subscribe. Public by design. Creates the key
 *                             pair on first use and keeps it in Vault.
 *   { mode: "process" }    -- pg_cron, every minute when there is something to
 *                             send. No session; gated by the same Vault shared
 *                             secret deliver-emails uses. Each notification is
 *                             checked against the person's preferences first
 *                             (inactive profiles, reviewer accounts, push switched
 *                             off, quiet mode) and the outcome is written to
 *                             notification_deliveries, which the email/text
 *                             fallback ladder reads.
 *   { mode: "test" }       -- a signed-in person sends a test push to their
 *                             own devices only.
 */


const VAPID_SECRET = "VAPID_KEYS";
const VAPID_SUBJECT = "mailto:admin@veritasvillage.org";

type VapidKeys = { publicKey: string; privateKey: string };

async function getVapidKeys(admin: SupabaseClient): Promise<VapidKeys> {
  const existing = await readVaultSecret(admin, VAPID_SECRET);
  if (existing) return JSON.parse(existing) as VapidKeys;
  await admin.rpc("vault_create_secret_if_absent", { secret_name: VAPID_SECRET, secret_value: JSON.stringify(webpush.generateVAPIDKeys()) });
  // Re-read rather than trust our own copy: if two first calls raced, only one
  // insert won and both must agree on which key pair that was.
  const stored = await readVaultSecret(admin, VAPID_SECRET);
  if (!stored) throw new Error("Could not store the VAPID key pair in Vault.");
  return JSON.parse(stored) as VapidKeys;
}

type Subscription = {
  id: string; user_id: string; platform: "web" | "ios" | "android";
  endpoint: string | null; p256dh: string | null; auth: string | null; device_token: string | null;
};
type Payload = { title: string; body: string; url: string; tag: string };

const SUB_COLUMNS = "id,user_id,platform,endpoint,p256dh,auth,device_token";

/** The Firebase key for the iOS and Android apps, from Vault. Null until it has been added. */
async function getFcmAccount(admin: SupabaseClient): Promise<ServiceAccount | null> {
  const raw = await readVaultSecret(admin, "FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    return parsed.project_id && parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    return null;
  }
}

/** Sends one payload to one device. Returns "gone" when the device has unsubscribed for good. */
async function sendOne(sub: Subscription, payload: Payload, fcm: ServiceAccount | null): Promise<"sent" | "gone" | "failed"> {
  if (sub.platform !== "web") {
    // Not set up yet is a failure for this send, not an error: the web side must keep working.
    if (!fcm || !sub.device_token) return "failed";
    return await sendFcm(fcm, sub.device_token, payload);
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint!, keys: { p256dh: sub.p256dh!, auth: sub.auth! } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24, urgency: "normal" },
    );
    return "sent";
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    return status === 404 || status === 410 ? "gone" : "failed";
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const body = await req.json().catch(() => null) as { mode?: string } | null;

  if (body?.mode === "public-key") {
    const keys = await getVapidKeys(admin);
    return json({ publicKey: keys.publicKey });
  }

  if (body?.mode === "test") {
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Your session has expired. Please sign in again." }, 401);

    const keys = await getVapidKeys(admin);
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    const fcm = await getFcmAccount(admin);
    const { data: subs } = await admin.from("push_subscriptions").select(SUB_COLUMNS).eq("user_id", user.id);
    const results = await Promise.all(((subs ?? []) as Subscription[]).map(async (sub) => ({
      sub, result: await sendOne(sub, { title: "Veritas Village", body: "Notifications are working on this device.", url: "/family-village/home", tag: "test" }, fcm),
    })));
    const gone = results.filter((r) => r.result === "gone").map((r) => r.sub.id);
    if (gone.length) await admin.from("push_subscriptions").delete().in("id", gone);
    return json({ ok: true, sent: results.filter((r) => r.result === "sent").length });
  }

  if (body?.mode === "process") {
    const secret = await readVaultSecret(admin, "EMAIL_DELIVERY_SECRET");
    const presented = req.headers.get("x-delivery-secret") ?? "";
    if (!secret || !safeEqual(presented, secret)) return json({ error: "Unauthorized" }, 401);

    // 15 minutes, not a day: a person who turns notifications on later must not
    // receive a burst of yesterday's, and the cron runs every minute anyway.
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: recent } = await admin.from("notifications")
      .select("id,recipient_user_id,kind,title,body,link_path")
      .gte("created_at", since).order("created_at").limit(500);
    const candidates = (recent ?? []) as { id: string; recipient_user_id: string; kind: string; title: string; body: string | null; link_path: string | null }[];
    if (!candidates.length) return json({ ok: true, sent: 0 });

    // Claim first. ignoreDuplicates makes the insert return only the rows this
    // run actually created, so an overlapping run can't send the same one.
    const { data: claimedRows } = await admin.from("notification_push_log")
      .upsert(candidates.map((n) => ({ notification_id: n.id })), { onConflict: "notification_id", ignoreDuplicates: true })
      .select("notification_id");
    const claimed = new Set((claimedRows ?? []).map((row: { notification_id: string }) => row.notification_id));
    const work = candidates.filter((n) => claimed.has(n.id));
    if (!work.length) return json({ ok: true, sent: 0 });

    const userIds = [...new Set(work.map((n) => n.recipient_user_id))];
    const [{ data: subRows }, { data: accessRows }] = await Promise.all([
      admin.from("push_subscriptions").select(SUB_COLUMNS).in("user_id", userIds),
      admin.rpc("channel_access_for", { p_users: userIds }),
    ]);
    const subsByUser = new Map<string, Subscription[]>();
    for (const sub of (subRows ?? []) as Subscription[]) subsByUser.set(sub.user_id, [...(subsByUser.get(sub.user_id) ?? []), sub]);
    const accessByUser = new Map<string, Access>(((accessRows ?? []) as Access[]).map((row) => [row.user_id, row]));

    // Who is actually sent to: the person's own choices and the never-contact rules, in one place.
    const skipped: { n: (typeof work)[number]; reason: string }[] = [];
    const sendable = work.filter((n) => {
      const decision = decidePush(accessByUser.get(n.recipient_user_id), n.kind);
      if (!decision.send) skipped.push({ n, reason: decision.reason });
      return decision.send;
    });

    const keys = await getVapidKeys(admin);
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    const fcm = await getFcmAccount(admin);

    const gone = new Set<string>();
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 10;
    const jobs = sendable.flatMap((n) => (subsByUser.get(n.recipient_user_id) ?? []).map((sub) => ({ n, sub })));
    const perNotification = new Map<string, { sent: number; failed: number }>();
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
      await Promise.all(jobs.slice(i, i + BATCH_SIZE).map(async ({ n, sub }) => {
        // The link carries the notification's id so opening it counts as seeing it.
        const result = await sendOne(sub, { title: n.title, body: n.body ?? "", url: withOpenMarker(n.link_path, n.id), tag: n.id }, fcm);
        const tally = perNotification.get(n.id) ?? { sent: 0, failed: 0 };
        if (result === "sent") { sent += 1; tally.sent += 1; } else { failed += 1; tally.failed += 1; }
        if (result === "gone") gone.add(sub.id);
        perNotification.set(n.id, tally);
      }));
    }

    if (gone.size) await admin.from("push_subscriptions").delete().in("id", [...gone]);
    await Promise.all([...perNotification].map(([id, tally]) =>
      admin.from("notification_push_log").update({ sent_count: tally.sent, failed_count: tally.failed }).eq("notification_id", id)));

    // The delivery log: one push row per notification, so the ladder knows whether push went
    // through (wait for the day to pass), failed (email straight away), or was never possible.
    const now = new Date().toISOString();
    const logRows = [
      ...sendable.map((n) => {
        const tally = perNotification.get(n.id) ?? { sent: 0, failed: 0 };
        const delivered = tally.sent > 0;
        return {
          notification_id: n.id, user_id: n.recipient_user_id, channel: "push", attempt: 1,
          status: delivered ? "sent" : "failed", reason: delivered ? null : "send_failed",
          provider: "push", sent_at: delivered ? now : null, updated_at: now,
        };
      }),
      ...skipped.map(({ n, reason }) => ({
        notification_id: n.id, user_id: n.recipient_user_id, channel: "push", attempt: 1,
        status: "skipped", reason, updated_at: now,
      })),
    ];
    if (logRows.length) await admin.from("notification_deliveries").upsert(logRows, { onConflict: "notification_id,channel,attempt" });
    return json({ ok: true, sent, failed, skipped: skipped.length, removed: gone.size });
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
        const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
        await logEdgeError(admin, "deliver-push", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
