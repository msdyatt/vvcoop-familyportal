import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { needsMfaStepUp } from "./aal.ts";
import { json } from "./http.ts";
import type { AdminClient } from "./types.ts";

export type Caller = { userId: string; email: string | null; admin: AdminClient; isAdmin: boolean };

/**
 * Who is calling a browser-facing function: their own token is checked first,
 * then the service role does the work. Returns a Response to send straight back
 * when the caller is not allowed. Two-factor step-up is enforced for everyone,
 * because this is money.
 */
export async function authenticate(req: Request, options: { adminOnly?: boolean } = {}): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey || !authorization) return { ok: false, response: json({ error: "Unauthorized" }, 401) };

  const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return { ok: false, response: json({ error: "Your session has expired. Please sign in again." }, 401) };

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const [{ data: profile }, { data: role }] = await Promise.all([
    admin.from("profiles").select("status").eq("id", user.id).single(),
    admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
  ]);
  if (profile?.status !== "active") return { ok: false, response: json({ error: "Your account is not active." }, 403) };
  if (options.adminOnly && !role) return { ok: false, response: json({ error: "Administrator access is required." }, 403) };
  if (await needsMfaStepUp(userClient)) return { ok: false, response: json({ error: "Complete two-factor verification before continuing." }, 403) };

  return { ok: true, caller: { userId: user.id, email: user.email ?? null, admin, isAdmin: Boolean(role) } };
}
