"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "./supabase";

/**
 * Shared entry gate for the staff workspaces.
 *
 * The Admin and Teacher workspaces each carried their own copy of the same
 * check: fetch the user, confirm the profile is active, confirm the required
 * role, then collect every role for the workspace switcher.
 *
 * The copies also missed something the Family portal did do -- the
 * authenticator-assurance-level check. A member with 2FA enabled who navigated
 * straight to /family-village/admin or /family-village/teacher was never asked
 * for their second factor, because only /home performed that step. Folding the
 * AAL check in here closes that for both workspaces.
 */
export type PortalAccessState = "loading" | "denied" | "mfa-challenge" | "ready";

export type PortalAccess = {
  state: PortalAccessState;
  userId: string;
  roles: string[];
  /** Re-runs the gate; pass to the MFA screen so it can continue after verifying. */
  recheck: () => void;
};

export function usePortalAccess(requiredRole: "admin" | "teacher"): PortalAccess {
  const [state, setState] = useState<PortalAccessState>(() => getSupabaseBrowserClient() ? "loading" : "denied");
  const [userId, setUserId] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) { if (!cancelled) setState("denied"); return; }

      const { data } = await supabase.auth.getUser();
      if (!data.user) { if (!cancelled) setState("denied"); return; }

      const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal.data && aal.data.nextLevel === "aal2" && aal.data.nextLevel !== aal.data.currentLevel) {
        if (!cancelled) setState("mfa-challenge");
        return;
      }

      const [{ data: profile }, { data: role }, { data: allRoles }] = await Promise.all([
        supabase.from("profiles").select("status").eq("id", data.user.id).single(),
        supabase.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", requiredRole).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", data.user.id),
      ]);

      if (cancelled) return;
      if (profile?.status !== "active" || !role) { setState("denied"); return; }

      setUserId(data.user.id);
      setRoles((allRoles ?? []).map((item) => item.role));
      setState("ready");
    }

    check();
    return () => { cancelled = true; };
  }, [requiredRole, attempt]);

  return { state, userId, roles, recheck: () => setAttempt((n) => n + 1) };
}
