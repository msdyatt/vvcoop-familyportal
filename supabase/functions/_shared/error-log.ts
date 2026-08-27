import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";

/**
 * Writes a row to public.error_log using a service-role client, which
 * bypasses RLS the same way every other admin-gated edge function already
 * does. Never throws itself -- a failed error report should not mask or
 * replace the original failure.
 */
export async function logEdgeError(adminClient: SupabaseClient, source: string, error: unknown, context?: Record<string, unknown>) {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? null : null;
    await adminClient.from("error_log").insert({ source: `edge_function:${source}`, message, stack, context: context ?? null });
  } catch {
    // Logging the error must never itself throw.
  }
}
