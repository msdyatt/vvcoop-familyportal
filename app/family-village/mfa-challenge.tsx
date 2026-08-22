"use client";

import { FormEvent, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";

/**
 * Second-factor prompt shown when the session's authenticator assurance level
 * is below what the account requires. Extracted from the Family portal so the
 * Teacher and Admin workspaces can enforce the same step -- previously only
 * /family-village/home challenged for it.
 */
export default function MfaChallengeScreen({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const factors = await supabase.auth.mfa.listFactors();
    const totpFactor = factors.data?.totp?.[0];
    if (!totpFactor) { setMessage("No two-factor method found on this account."); setBusy(false); return; }
    const challenge = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
    if (challenge.error) { setMessage(challenge.error.message); setBusy(false); return; }
    const verifyResult = await supabase.auth.mfa.verify({ factorId: totpFactor.id, challengeId: challenge.data.id, code });
    setBusy(false);
    if (verifyResult.error) { setMessage(verifyResult.error.message); return; }
    onVerified();
  }

  return <main className="portal-state">
    <p className="eyebrow">Two-factor authentication</p>
    <h1>Enter your verification code.</h1>
    <form onSubmit={submit} className="household-form mfa-form">
      <label>6-digit code<input value={code} onChange={(event) => setCode(event.target.value.trim())} maxLength={6} disabled={busy} /></label>
      <button disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
    </form>
    <p className="setup-note" role="status">{message}</p>
    <button className="mode-switch" onClick={onCancel}>Sign out instead</button>
  </main>;
}
