import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { ReplyRefused, sendReply } from "../_shared/office-inbox.ts";
import { authenticateInboxAdmin, loadInboxConfig } from "../_shared/office-inbox-env.ts";

/**
 * Sends an administrator's reply from the office address, in the family's Gmail thread.
 *
 *   POST { threadId, body, clientKey, nextStatus? }   nextStatus: "waiting" (default), "open" or "done"
 *
 * The database records who is sending before anything goes out, enforces the limits
 * (20 an hour per administrator, 60 an hour for the office, one per conversation every
 * 10 seconds) and treats a repeated clientKey as the same reply, so a double click or a retry
 * after a timeout never sends twice. Every send, and every failure, is logged.
 */
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateInboxAdmin(req);
  if (!auth.ok) return auth.response;
  const loaded = loadInboxConfig();
  if (!loaded.ok) return json({ error: "The office inbox is not set up yet." }, 400);

  const body = await req.json().catch(() => null) as { threadId?: string; body?: string; clientKey?: string; nextStatus?: string } | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!body?.threadId || !uuid.test(body.threadId) || !body.clientKey || !uuid.test(body.clientKey)) return json({ error: "Missing conversation." }, 400);
  if (typeof body.body !== "string" || !body.body.trim()) return json({ error: "Write the reply first." }, 400);
  const nextStatus = body.nextStatus === "done" || body.nextStatus === "open" ? body.nextStatus : "waiting";

  const { admin } = auth.caller;
  try {
    const result = await sendReply(
      { rpc: (fn, args) => admin.rpc(fn, args), fetch, oauth: { clientId: loaded.config.clientId, clientSecret: loaded.config.clientSecret } },
      { userId: auth.caller.userId, threadId: body.threadId, body: body.body, clientKey: body.clientKey, nextStatus },
    );
    if (!result.ok) {
      await logEdgeError(admin, "office-inbox-send", new Error(result.error), { thread: body.threadId });
      return json({ error: result.error }, 502);
    }
    return json(result);
  } catch (error) {
    if (error instanceof ReplyRefused) return json({ error: error.message }, 400);
    throw error;
  }
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        await logEdgeError(createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }), "office-inbox-send", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
