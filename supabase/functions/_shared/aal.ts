import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";

/** The bare access token from an `Authorization: Bearer <token>` header. */
export function bearerToken(authorization: string | null | undefined): string {
  return (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * True if this caller is missing a required MFA step-up: the account has a
 * verified second factor enrolled, but the caller's token has not reached
 * aal2.
 *
 * The caller's token must be passed in. The edge functions build their user
 * client from a forwarded `Authorization` header only, so the client never
 * holds a stored session, and `getAuthenticatorAssuranceLevel()` with no
 * argument reads that (empty) stored session and reports `nextLevel: null`,
 * which used to make this check pass for every aal1 token (issue #161). With
 * the token, auth-js decodes its `aal` claim and loads the user's factors
 * with it.
 *
 * Fails closed: no token, an error or no answer from auth all count as
 * "step-up needed". Every function here does privileged work through a
 * service-role client afterward, which bypasses the database's own
 * private.aal_satisfied() policies, so this check is the one that matters.
 */
export async function needsMfaStepUp(userClient: SupabaseClient, authorization: string | null | undefined): Promise<boolean> {
  const token = bearerToken(authorization);
  if (!token) return true;
  const { data, error } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (error || !data) return true;
  return data.nextLevel === "aal2" && data.nextLevel !== data.currentLevel;
}
