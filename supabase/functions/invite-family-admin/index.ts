import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { sendAndLog } from "../_shared/resend.ts";
import { escapeHtml, renderEmail } from "../_shared/email-template.ts";
import { needsMfaStepUp } from "../_shared/aal.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

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

    const body = await req.json().catch(() => null) as { email?: string; familyName?: string; adminName?: string; note?: string; familyId?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    let familyName = body?.familyName?.trim();
    const adminName = body?.adminName?.trim();
    // familyId means "add this person to an existing household" (the
    // Families tab's "Invite another adult"), rather than the original
    // "invite a new household" flow -- everything else is shared.
    const familyId = body?.familyId?.trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !adminName) return json({ error: "A name and a valid email are required." }, 400);
    if (!familyId && !familyName) return json({ error: "A family name is required for a new household." }, 400);

    // Resolve the household first (existing lookup or new insert), so its
    // real name is available both for the auth user's metadata and the email
    // below -- rather than trusting whatever familyName the caller passed
    // when adding to an existing household, where the real name of record
    // should win.
    let familyRecordId: string;
    if (familyId) {
      const { data: existingFamily, error: existingFamilyError } = await adminClient
        .from("families").select("id,display_name,last_name").eq("id", familyId).maybeSingle();
      if (existingFamilyError || !existingFamily) return json({ error: "That household could not be found." }, 404);
      familyRecordId = existingFamily.id;
      familyName = existingFamily.last_name || existingFamily.display_name;
    } else {
      const { data: created, error: familyError } = await adminClient.from("families").insert({ display_name: familyName }).select("id").single();
      if (familyError || !created) return json({ error: "The household record needs administrator attention." }, 500);
      familyRecordId = created.id;
    }

    const redirectTo = "https://family.veritasvillage.org/family-village/accept-invite";
    // generateLink creates the auth user the same way inviteUserByEmail does,
    // but -- unlike inviteUserByEmail -- never sends an email itself. That's
    // exactly what's wanted: Supabase's own invite template is plain and
    // unbranded, so this sends its own email via Resend below instead, using
    // the same link.
    const { data: invited, error: inviteError } = await adminClient.auth.admin.generateLink({
      type: "invite", email,
      options: { redirectTo, data: { display_name: adminName, family_name: familyName, invited_by: user.id, note: body?.note?.trim() || "" } },
    });
    if (inviteError || !invited.user) return json({ error: inviteError?.message ?? "The invitation could not be created." }, 400);
    const actionLink = invited.properties?.action_link;
    if (!actionLink) return json({ error: "The invitation was created but no link came back. Nothing was emailed." }, 500);

    const invitationId = crypto.randomUUID();
    const tokenBytes = new TextEncoder().encode(`${invitationId}:${email}:${user.id}`);
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    // 24 hours -- the longest Supabase Auth allows for an email link's own
    // validity (Auth > Providers > Email > Email OTP Expiration, capped at
    // 86400s server-side). Setting this column any longer would just be lying
    // about how long the link actually works.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const setupResults = await Promise.all([
      adminClient.from("profiles").update({ display_name: adminName, status: "active" }).eq("id", invited.user.id),
      adminClient.from("family_members").insert({ family_id: familyRecordId, user_id: invited.user.id, relationship: familyId ? "Household adult" : "Family administrator" }),
      adminClient.from("user_roles").insert({ user_id: invited.user.id, role: "parent" }),
      adminClient.from("invitations").insert({ id: invitationId, email, family_id: familyRecordId, invited_by_user_id: user.id, token_hash: tokenHash, expires_at: expiresAt }),
      adminClient.from("audit_log").insert({ actor_user_id: user.id, action: familyId ? "family_adult_invited" : "family_admin_invited", subject_type: "family", subject_id: familyRecordId, detail: { email, family_name: familyName } }),
    ]);
    if (setupResults.some(result => result.error)) return json({ error: "Part of the household setup needs administrator attention. No email was sent yet." }, 500);

    const note = body?.note?.trim();
    // adminName/familyName are admin-typed free text, not markup -- escape
    // before splicing into the *Html fields below, or a stray "&"/"<" (or a
    // deliberate tag) breaks the card layout or rides along inside an email
    // recipients are primed to trust. The note is plain text too; \n -> <br>
    // after escaping keeps line breaks without opening the door to raw HTML.
    const safeAdminName = escapeHtml(adminName);
    const safeFamilyName = escapeHtml(familyName);
    const safeNote = note ? escapeHtml(note).replace(/\n/g, "<br>") : undefined;
    const html = renderEmail({
      eyebrow: "You're invited",
      heading: familyId ? "There is a place for you at the table." : "There is a place for your family at the table.",
      preheader: `${safeAdminName}, ${safeFamilyName}'s invitation to Veritas Village is ready.`,
      bodyHtml: familyId
        ? `<p>Hello ${safeAdminName},</p><p>You have been invited to join the <b>${safeFamilyName}</b> household in Family Village, Veritas Village's private portal for classes, schedules, notes, and paperwork.</p>`
        : `<p>Hello ${safeAdminName},</p><p>You have been invited to join Family Village, the private home for Veritas Village families.</p>`,
      noteHtml: safeNote,
      ctaLabel: "Accept your invitation",
      ctaUrl: actionLink,
      footerHtml: "This private link expires in 24 hours.",
    });
    const emailResult = await sendAndLog(adminClient, {
      to: email, subject: "You're invited to Veritas Village Family Village",
      html, kind: "invite", subjectType: "family", subjectId: familyRecordId,
    });
    if (!emailResult.ok) return json({ ok: true, email, familyName, expiresAt, warning: `The account was created, but the invite email could not be sent: ${emailResult.error}` });

    return json({ ok: true, email, familyName, expiresAt });
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
        await logEdgeError(adminClient, "invite-family-admin", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
