import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { checkCredentials, getDocumentState, mapStatus } from "../_shared/opensign.ts";

/**
 * Asks OpenSign what happened to every document still outstanding.
 *
 * The webhook is the instant path, but it depends on a secret that has to be
 * generated after deployment and can quietly stop working. Polling is the one
 * that works without configuration, and it doubles as the safety net when a
 * callback is missed -- a signed waiver that never made it back is exactly the
 * failure a co-op would not notice until someone needed the record.
 *
 * When a document completes, the signed PDF and its certificate are stored so
 * the family can open their own copy from the portal.
 */

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const PRIVATE_BUCKET = "family-village-private";

/**
 * Pulls the finished document into our own storage.
 *
 * OpenSign's file URL is not a durable home for a legal record -- it depends on
 * their account staying live and the link staying valid. A copy is kept here.
 */
async function storeSignedCopy(
  adminClient: ReturnType<typeof createClient>,
  fileUrl: string,
  familyId: string | null,
  title: string,
): Promise<string | null> {
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const path = `signed/${crypto.randomUUID()}.pdf`;
    const upload = await adminClient.storage.from(PRIVATE_BUCKET)
      .upload(path, bytes, { contentType: "application/pdf", upsert: false });
    if (upload.error) return null;

    const { data } = await adminClient.from("documents").insert({
      family_id: familyId,
      kind: "signed",
      title: `${title} (signed)`,
      storage_path: path,
      signature_provider: "opensign",
      signature_status: "signed",
    }).select("id").single();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiToken = Deno.env.get("OPENSIGN_API_TOKEN");
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
    if (!apiToken) return json({ error: "OpenSign is not configured. Set the OPENSIGN_API_TOKEN secret." }, 400);

    const { data: integration } = await adminClient
      .from("integration_settings").select("api_base_url").eq("id", "opensign").maybeSingle();
    const baseUrl = integration?.api_base_url?.trim();
    if (!baseUrl) return json({ error: "Set the OpenSign API base URL in Admin → Integrations first." }, 400);

    // "Does OpenSign accept our credentials?" is a different question from
    // "has anyone signed?", and answering it separately means a rotated token
    // reads as a rotated token instead of as an empty inbox.
    const body = await req.json().catch(() => null) as { mode?: string } | null;
    if (body?.mode === "test") {
      const check = await checkCredentials(baseUrl, apiToken);
      await adminClient.from("integration_settings")
        .update({ status: check.ok ? "connected" : "attention" }).eq("id", "opensign");
      return json({ ok: check.ok, detail: check.detail });
    }

    // Anything sent but not yet settled.
    const { data: pending } = await adminClient
      .from("family_requirements")
      .select("id,family_id,status,provider_document_id,signed_document_id,requirements(title)")
      .not("provider_document_id", "is", null)
      .in("status", ["sent", "outstanding"]);

    const rows = (pending ?? []) as unknown as {
      id: string; family_id: string; status: string; provider_document_id: string;
      signed_document_id: string | null; requirements: { title: string } | null;
    }[];

    let checked = 0;
    let completed = 0;
    const problems: string[] = [];

    for (const row of rows) {
      checked += 1;
      try {
        const state = await getDocumentState(baseUrl, apiToken, row.provider_document_id);
        const mapped = mapStatus(state.status);
        const patch: Record<string, unknown> = { last_synced_at: new Date().toISOString() };

        if (mapped === "signed") {
          patch.status = "complete";
          patch.signed_at = new Date().toISOString();
          if (state.certificateUrl) patch.certificate_url = state.certificateUrl;
          if (state.fileUrl && !row.signed_document_id) {
            const documentId = await storeSignedCopy(adminClient, state.fileUrl, row.family_id, row.requirements?.title ?? "Document");
            if (documentId) patch.signed_document_id = documentId;
          }
          completed += 1;
        } else if (mapped === "declined" || mapped === "expired") {
          patch.status = "outstanding";
          patch.note = `OpenSign reported the document ${mapped}.`;
        } else if (mapped) {
          patch.status = "sent";
        }

        const { error } = await adminClient.from("family_requirements").update(patch).eq("id", row.id);
        if (error) problems.push(`${row.id}: ${error.message}`);
      } catch (error) {
        problems.push(`${row.provider_document_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return json({ ok: true, checked, completed, problems });
  },
};
