import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";

/**
 * vault.decrypted_secrets is never itself exposed via PostgREST -- that would
 * leak every secret to anyone who could reach the REST API. This calls
 * public.read_vault_secret(name) instead, a SECURITY DEFINER bridge whose
 * EXECUTE grant is restricted to service_role -- which is exactly what every
 * caller of this helper authenticates as, and nothing a browser session can
 * reach.
 */
export async function readVaultSecret(admin: SupabaseClient, name: string): Promise<string | null> {
  const { data } = await admin.rpc("read_vault_secret", { secret_name: name });
  return (data as string | null) ?? null;
}

export async function sendViaResend(apiKey: string, from: string, to: string, subject: string, html: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (response.ok) return { ok: true };
  const text = await response.text().catch(() => "");
  return { ok: false, error: `Resend returned ${response.status}: ${text.slice(0, 300)}` };
}

/**
 * Sends one email immediately (not queued) and logs it to email_outbox either
 * way, so every email this app sends -- invites, ad-hoc reminders, the daily
 * compliance-reminder cron -- shows up in the same place for an admin to
 * audit, regardless of which path sent it.
 */
export async function sendAndLog(
  admin: SupabaseClient,
  opts: { to: string; subject: string; html: string; kind: string; subjectType?: string; subjectId?: string },
): Promise<{ ok: boolean; error?: string }> {
  // Independent reads (a table, a Vault secret) -- no reason to pay for two
  // round trips back to back instead of one.
  const [from, apiKey] = await Promise.all([getFromAddress(admin), readVaultSecret(admin, "RESEND_API_KEY")]);
  if (!from || !apiKey) {
    const error = !from ? "No From address configured for Resend." : "Resend API key not set.";
    await admin.from("email_outbox").insert({
      recipient_email: opts.to, subject: opts.subject, html_body: opts.html,
      kind: opts.kind, subject_type: opts.subjectType ?? null, subject_id: opts.subjectId ?? null,
      status: "pending", error_detail: error,
    });
    return { ok: false, error };
  }

  const result = await sendViaResend(apiKey, from, opts.to, opts.subject, opts.html);
  await admin.from("email_outbox").insert({
    recipient_email: opts.to, subject: opts.subject, html_body: opts.html,
    kind: opts.kind, subject_type: opts.subjectType ?? null, subject_id: opts.subjectId ?? null,
    status: result.ok ? "sent" : "failed",
    sent_at: result.ok ? new Date().toISOString() : null,
    error_detail: result.ok ? null : result.error,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function getFromAddress(admin: SupabaseClient): Promise<string | null> {
  const { data } = await admin.from("integration_settings").select("from_address").eq("id", "resend").maybeSingle();
  return (data as { from_address: string | null } | null)?.from_address?.trim() || null;
}
