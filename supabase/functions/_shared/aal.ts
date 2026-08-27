import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";

/**
 * True if this session is missing a required MFA step-up: the account has a
 * verified second factor enrolled, but the current session's authenticator
 * assurance level hasn't actually reached aal2 yet.
 *
 * Mirrors the exact check the app's own UI already makes (mfa-challenge.tsx /
 * portal-gate.tsx: `nextLevel === "aal2" && nextLevel !== currentLevel`) --
 * that check only ever ran in the browser, so a privileged edge function
 * reached directly with a valid-but-lower-assurance JWT bypassed the UI gate
 * entirely. The same restrictive database policy (private.aal_satisfied())
 * covers this function's own table reads/writes once it runs as the
 * caller's session, but every function here also does privileged work
 * through a service-role client afterward, which bypasses RLS altogether --
 * this is what still needs checking explicitly before that point.
 */
export async function needsMfaStepUp(userClient: SupabaseClient): Promise<boolean> {
  const { data } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!data) return false;
  return data.nextLevel === "aal2" && data.nextLevel !== data.currentLevel;
}
