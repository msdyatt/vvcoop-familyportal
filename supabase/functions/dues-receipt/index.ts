import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { corsHeaders, json } from "../_shared/http.ts";
import { logEdgeError } from "../_shared/error-log.ts";
import { loadReceipt } from "../_shared/dues-receipt.ts";
import { buildReceiptPdf } from "../_shared/receipt-pdf.ts";

/**
 * Returns a PDF receipt for one settled payment or refund.
 *
 *   { paymentId }  ->  application/pdf
 *
 * Read with the caller's own token, so row level security decides whether they
 * may see the payment: a household gets its own receipts, an administrator
 * everyone's, and nobody else gets anything.
 */
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authorization = req.headers.get("Authorization");
  if (!supabaseUrl || !publishableKey || !authorization) return json({ error: "Unauthorized" }, 401);
  const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "Your session has expired. Please sign in again." }, 401);

  const body = await req.json().catch(() => null) as { paymentId?: string } | null;
  const paymentId = body?.paymentId?.trim();
  if (!paymentId) return json({ error: "Say which payment." }, 400);

  const receipt = await loadReceipt(userClient, paymentId);
  if (!receipt) return json({ error: "No receipt is available for that payment." }, 404);

  const pdf = buildReceiptPdf(receipt);
  return new Response(pdf as BodyInit, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="receipt-${receipt.receiptNumber}.pdf"`, "Cache-Control": "private, no-store" },
  });
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
        await logEdgeError(adminClient, "dues-receipt", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
