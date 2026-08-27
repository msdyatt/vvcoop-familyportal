import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { sendAndLog } from "../_shared/resend.ts";
import { escapeHtml, renderEmail } from "../_shared/email-template.ts";
import { needsMfaStepUp } from "../_shared/aal.ts";

/**
 * Sends an ad-hoc compliance reminder to one household right now, on admin
 * request -- the Families tab's "Send reminder" button. This is deliberately
 * separate from the daily automated pass (send_compliance_reminders, a
 * pg_cron job): that one runs on a schedule and only fires at fixed
 * thresholds before a due date; this one exists for "nudge this family today"
 * regardless of where they land on that schedule.
 *
 * Outstanding items are looked up here, from the database, rather than
 * trusted from the client -- the Families tab already shows counts, but an
 * admin-triggered send should reflect real current state, not whatever the
 * browser happened to have cached.
 */

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type OutstandingRow = {
  status: string;
  requirements: { kind: string; title: string; due_on: string | null; active: boolean; school_years: { is_current: boolean } | null } | null;
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey || !authorization) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Your session has expired. Please sign in again." }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const [{ data: profile }, { data: role }] = await Promise.all([
    adminClient.from("profiles").select("status").eq("id", user.id).single(),
    adminClient.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
  ]);
  if (profile?.status !== "active" || !role) return json({ error: "Administrator access is required." }, 403);
  if (await needsMfaStepUp(userClient)) return json({ error: "Complete two-factor verification before continuing." }, 403);

  const body = await req.json().catch(() => null) as { familyId?: string } | null;
  const familyId = body?.familyId?.trim();
  if (!familyId) return json({ error: "A family id is required." }, 400);

  const [{ data: family }, { data: outstandingRows }, { data: memberRows }] = await Promise.all([
    adminClient.from("families").select("id,display_name,last_name").eq("id", familyId).maybeSingle(),
    adminClient.from("family_requirements")
      .select("status,requirements!inner(kind,title,due_on,active,school_years!inner(is_current))")
      .eq("family_id", familyId)
      .eq("requirements.active", true)
      .eq("requirements.school_years.is_current", true)
      .in("status", ["outstanding", "sent"]),
    adminClient.from("family_members").select("user_id,profiles(email,display_name,status)").eq("family_id", familyId),
  ]);
  if (!family) return json({ error: "That household could not be found." }, 404);

  const outstanding = (outstandingRows ?? []) as unknown as OutstandingRow[];
  if (!outstanding.length) return json({ error: "This household has nothing outstanding right now." }, 400);

  type MemberRow = { user_id: string; profiles: { email: string; display_name: string | null; status: string } | null };
  const recipients = ((memberRows ?? []) as unknown as MemberRow[])
    .filter((row) => row.profiles?.status === "active" && row.profiles.email)
    .map((row) => ({ email: row.profiles!.email, name: row.profiles!.display_name }));
  if (!recipients.length) return json({ error: "No active adult on this household has an email on file." }, 400);

  // Requirement titles and the household name are all admin-typed free text,
  // not markup -- escape before splicing into the *Html fields below (see
  // escapeHtml's own comment in _shared/email-template.ts).
  const items = outstanding.map((row) => {
    const title = escapeHtml(row.requirements?.title ?? "an item");
    const due = row.requirements?.due_on ? ` (due ${new Date(row.requirements.due_on + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" })})` : "";
    return `<li>${title}${due}</li>`;
  }).join("");
  const householdName = escapeHtml(family.last_name || family.display_name);

  const html = renderEmail({
    eyebrow: "A reminder",
    heading: "A few things still need your attention.",
    preheader: `${householdName} has ${outstanding.length} outstanding item${outstanding.length === 1 ? "" : "s"} in Family Village.`,
    bodyHtml: `<p>Hello,</p><p>A quick reminder that the <b>${householdName}</b> household has the following still outstanding in Family Village:</p><ul>${items}</ul><p>You can take care of these under Paperwork &amp; dues in the portal.</p>`,
    ctaLabel: "Open Family Village",
    ctaUrl: "https://family.veritasvillage.org/family-village/home",
  });

  const results = await Promise.all(recipients.map((recipient) =>
    sendAndLog(adminClient, {
      to: recipient.email, subject: "A reminder from Veritas Village",
      html, kind: "manual_reminder", subjectType: "family", subjectId: family.id,
    }),
  ));
  const sent = results.filter((result) => result.ok).length;

  await adminClient.from("audit_log").insert({
    actor_user_id: user.id, action: "reminder_sent", subject_type: "family", subject_id: family.id,
    detail: { family: householdName, recipients: recipients.length, sent, items: outstanding.length },
  });

  if (!sent) return json({ ok: false, error: results.find((result) => result.error)?.error ?? "The reminder could not be sent." });
  return json({ ok: true, sent, recipients: recipients.length });
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
        await logEdgeError(adminClient, "send-family-reminder", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
