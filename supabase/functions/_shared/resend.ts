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

export type ResendResult = { ok: true; id: string | null } | { ok: false; error: string; retryable: boolean };

/**
 * One email through Resend. `idempotencyKey` makes Resend treat a repeat of the same
 * request (a retry after a timeout, say) as the original instead of sending twice.
 * `retryable` is false for an answer that trying again cannot change (a bad address,
 * a rejected request) and true for trouble that may pass (a timeout, a rate limit, a 5xx).
 */
export async function sendViaResend(
  apiKey: string, from: string, to: string, subject: string, html: string,
  options: { idempotencyKey?: string } = {},
): Promise<ResendResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", { method: "POST", headers, body: JSON.stringify({ from, to, subject, html }) });
  } catch (error) {
    return { ok: false, error: `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }
  if (response.ok) {
    const body = await response.json().catch(() => null) as { id?: string } | null;
    return { ok: true, id: body?.id ?? null };
  }
  const text = await response.text().catch(() => "");
  const retryable = response.status === 429 || response.status >= 500 || response.status === 409;
  return { ok: false, error: `Resend returned ${response.status}: ${text.slice(0, 300)}`, retryable };
}

/**
 * Sends one email immediately (not queued) and logs it to email_outbox either
 * way, so every email this app sends -- invites, ad-hoc reminders, the daily
 * compliance-reminder cron -- shows up in the same place for an admin to
 * audit, regardless of which path sent it.
 */
export async function sendAndLog(
  admin: SupabaseClient,
  opts: { to: string; subject: string; html: string; kind: string; subjectType?: string; subjectId?: string; idempotencyKey?: string; queueWhenUnconfigured?: boolean },
): Promise<{ ok: boolean; error?: string; id?: string | null; retryable?: boolean; unconfigured?: boolean }> {
  // Independent reads (a table, a Vault secret) -- no reason to pay for two
  // round trips back to back instead of one.
  const [from, apiKey] = await Promise.all([getFromAddress(admin), readVaultSecret(admin, "RESEND_API_KEY")]);
  if (!from || !apiKey) {
    const error = !from ? "No From address configured for Resend." : "Resend API key not set.";
    // The notification ladder keeps its own queue and must not leave a pending outbox row
    // behind, or the daily drain would send it again once Resend is set up.
    if (opts.queueWhenUnconfigured === false) return { ok: false, error, retryable: true, unconfigured: true };
    await admin.from("email_outbox").insert({
      recipient_email: opts.to, subject: opts.subject, html_body: opts.html,
      kind: opts.kind, subject_type: opts.subjectType ?? null, subject_id: opts.subjectId ?? null,
      status: "pending", error_detail: error,
    });
    return { ok: false, error };
  }

  const result = await sendViaResend(apiKey, from, opts.to, opts.subject, opts.html, { idempotencyKey: opts.idempotencyKey });
  await admin.from("email_outbox").insert({
    recipient_email: opts.to, subject: opts.subject, html_body: opts.html,
    kind: opts.kind, subject_type: opts.subjectType ?? null, subject_id: opts.subjectId ?? null,
    status: result.ok ? "sent" : "failed",
    sent_at: result.ok ? new Date().toISOString() : null,
    error_detail: result.ok ? null : result.error,
  });
  return result.ok ? { ok: true, id: result.id } : { ok: false, error: result.error, retryable: result.retryable };
}

export async function getFromAddress(admin: SupabaseClient): Promise<string | null> {
  const { data } = await admin.from("integration_settings").select("from_address").eq("id", "resend").maybeSingle();
  return (data as { from_address: string | null } | null)?.from_address?.trim() || null;
}
