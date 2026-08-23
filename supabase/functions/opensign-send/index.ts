import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { OpenSignError, sendForSignature, sendFromTemplate } from "../_shared/opensign.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const PRIVATE_BUCKET = "family-village-private";

function toBase64(bytes: Uint8Array) {
  // btoa needs a binary string; chunked to avoid blowing the argument limit on
  // multi-megabyte PDFs.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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

    // Same gate as invite-family-admin: verify the caller with their own token,
    // then act with the service role.
    const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Your session has expired. Please sign in again." }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const [{ data: profile }, { data: role }] = await Promise.all([
      adminClient.from("profiles").select("status").eq("id", user.id).single(),
      adminClient.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
    ]);
    if (profile?.status !== "active" || !role) return json({ error: "Administrator access is required." }, 403);

    if (!apiToken) {
      return json({ error: "OpenSign is not configured. Set the OPENSIGN_API_TOKEN secret with `supabase secrets set OPENSIGN_API_TOKEN=...`." }, 400);
    }

    const body = await req.json().catch(() => null) as {
      /** Preferred: send the co-op's existing OpenSign template. */
      templateId?: string;
      documentId?: string;
      /** When present the signing link is written back to this compliance row,
          so the family sees "Sign now" in the portal instead of waiting on mail. */
      familyRequirementId?: string;
      signers?: { email?: string; name?: string; role?: string; widgets?: unknown[] }[];
      sendInOrder?: boolean;
      title?: string;
      note?: string;
      timeToCompleteDays?: number;
      sendEmail?: boolean;
    } | null;

    const templateId = body?.templateId?.trim();
    const documentId = body?.documentId?.trim();
    const familyRequirementId = body?.familyRequirementId?.trim();
    const signers = (body?.signers ?? [])
      .map((s) => ({
        email: s.email?.trim().toLowerCase() ?? "",
        name: s.name?.trim(),
        role: s.role?.trim(),
        // Widgets are passed straight through when supplied, so a longer
        // document can place its signature box without a code change.
        widgets: Array.isArray(s.widgets) ? s.widgets as never : undefined,
      }))
      .filter((s) => s.email);

    if (!templateId && !documentId) return json({ error: "Either a templateId or a documentId is required." }, 400);
    if (!signers.length) return json({ error: "At least one signer email is required." }, 400);

    // Base URL is per-installation, so it lives in integration_settings where an
    // administrator can set it from the Integrations tab.
    const { data: integration } = await adminClient
      .from("integration_settings").select("api_base_url,status").eq("id", "opensign").maybeSingle();
    const baseUrl = integration?.api_base_url?.trim();
    if (!baseUrl) {
      return json({ error: "Set the OpenSign API base URL in Admin → Integrations first (cloud is https://app.opensignlabs.com/api/v1.2)." }, 400);
    }

    // Template path needs no stored file: OpenSign already holds the document
    // and, more importantly, the positions of its signature fields.
    let document: { id: string; title: string; storage_path: string | null } | null = null;
    let fileBase64 = "";
    let title = body?.title?.trim() || "";

    if (!templateId) {
      const { data } = await adminClient
        .from("documents").select("id,title,storage_path").eq("id", documentId!).maybeSingle();
      if (!data) return json({ error: "That document could not be found." }, 404);
      if (!data.storage_path) return json({ error: "That document has no stored file to send." }, 400);
      document = data;
      title = title || data.title;
      const download = await adminClient.storage.from(PRIVATE_BUCKET).download(data.storage_path);
      if (download.error || !download.data) return json({ error: `The document file could not be read: ${download.error?.message ?? "unknown error"}` }, 500);
      fileBase64 = toBase64(new Uint8Array(await download.data.arrayBuffer()));
    }

    // Record the intent before calling out, so a failure is still visible in the
    // Admin workspace rather than vanishing.
    const { data: inserted, error: insertError } = await adminClient
      .from("signature_requests")
      .insert(signers.map((s) => ({
        document_id: document?.id ?? null,
        provider: "opensign",
        signer_email: s.email,
        signer_name: s.name ?? null,
        status: "pending",
        requested_by_user_id: user.id,
      })))
      .select("id,signer_email");
    if (insertError) return json({ error: insertError.message }, 500);

    const requestIds = (inserted ?? []).map((row) => row.id);

    try {
      const result = templateId
        ? await sendFromTemplate({
            baseUrl, token: apiToken, templateId,
            title: title || undefined,
            signers,
            sendInOrder: body?.sendInOrder,
            timeToCompleteDays: body?.timeToCompleteDays,
            sendEmail: body?.sendEmail,
          })
        : await sendForSignature({
            baseUrl, token: apiToken, title, fileBase64, signers,
            sendInOrder: body?.sendInOrder,
            note: body?.note,
            timeToCompleteDays: body?.timeToCompleteDays,
            sendEmail: body?.sendEmail,
          });

      const firstSigningUrl = signers.map((s) => result.signingUrls[s.email]).find(Boolean) ?? null;

      await Promise.all([
        // A requirement's master PDF is shared by every family, so its own row
        // must not be stamped with one household's provider id -- that state
        // belongs on the compliance row. Only a standalone document send, which
        // has no compliance row to write to, updates the document itself.
        familyRequirementId
          ? adminClient.from("family_requirements").update({
              status: "sent",
              provider_document_id: result.providerDocumentId,
              signing_url: firstSigningUrl,
              updated_by: user.id,
            }).eq("id", familyRequirementId)
          : document
            ? adminClient.from("documents").update({
                signature_provider: "opensign",
                provider_document_id: result.providerDocumentId,
                signature_status: "sent",
                updated_at: new Date().toISOString(),
              }).eq("id", document.id)
            : Promise.resolve(),
        ...(inserted ?? []).map((row) => adminClient.from("signature_requests").update({
          provider_document_id: result.providerDocumentId,
          status: "sent",
          signing_url: result.signingUrls[row.signer_email] ?? null,
        }).eq("id", row.id)),
      ]);

      return json({ ok: true, providerDocumentId: result.providerDocumentId, signers: signers.length, signingUrl: firstSigningUrl });
    } catch (error) {
      const message = error instanceof OpenSignError
        ? `OpenSign rejected the request: ${error.message}`
        : `OpenSign could not be reached: ${error instanceof Error ? error.message : String(error)}`;

      if (requestIds.length) {
        await adminClient.from("signature_requests")
          .update({ status: "failed", error_detail: message.slice(0, 500) })
          .in("id", requestIds);
      }
      if (familyRequirementId) {
        await adminClient.from("family_requirements").update({ note: message.slice(0, 500), updated_by: user.id }).eq("id", familyRequirementId);
      } else if (document) {
        await adminClient.from("documents").update({ signature_status: "failed" }).eq("id", document.id);
      }
      return json({ error: message }, 502);
    }
  },
};
