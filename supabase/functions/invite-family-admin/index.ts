import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  async fetch(req: Request) {
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

    const body = await req.json().catch(() => null) as { email?: string; familyName?: string; adminName?: string; note?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    const familyName = body?.familyName?.trim();
    const adminName = body?.adminName?.trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !familyName || !adminName) return json({ error: "Name, family name, and a valid email are required." }, 400);

    const redirectTo = "https://family.veritasvillage.org/family-village/accept-invite";
    const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo, data: { display_name: adminName, family_name: familyName, invited_by: user.id, note: body?.note?.trim() || "" } });
    if (inviteError || !invited.user) return json({ error: inviteError?.message ?? "The invitation could not be sent." }, 400);

    const invitationId = crypto.randomUUID();
    const tokenBytes = new TextEncoder().encode(`${invitationId}:${email}:${user.id}`);
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data: family, error: familyError } = await adminClient.from("families").insert({ display_name: familyName }).select("id").single();
    if (familyError || !family) return json({ error: "The email was sent, but the household record needs administrator attention." }, 500);

    const setupResults = await Promise.all([
      adminClient.from("profiles").update({ display_name: adminName, status: "active" }).eq("id", invited.user.id),
      adminClient.from("family_members").insert({ family_id: family.id, user_id: invited.user.id, relationship: "Family administrator" }),
      adminClient.from("user_roles").insert({ user_id: invited.user.id, role: "parent" }),
      adminClient.from("invitations").insert({ id: invitationId, email, family_id: family.id, invited_by_user_id: user.id, token_hash: tokenHash, expires_at: expiresAt }),
      adminClient.from("audit_log").insert({ actor_user_id: user.id, action: "family_admin_invited", subject_type: "family", subject_id: family.id, detail: { email, family_name: familyName } }),
    ]);
    if (setupResults.some(result => result.error)) return json({ error: "The invitation was sent, but part of the household setup needs administrator attention." }, 500);
    return json({ ok: true, email, familyName, expiresAt });
  },
};
