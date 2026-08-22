"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";

export default function AccountSettings({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return <div className="account-settings">
    <PasswordSection email={email} />
    <PasskeySection />
    <TwoFactorSection />
    <DangerZone onSignOut={onSignOut} />
  </div>;
}

function PasswordSection({ email }: { email: string }) {
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next.length < 8) { setStatus("New password must be at least 8 characters."); return; }
    if (next !== confirmPassword) { setStatus("New passwords don't match."); return; }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus("");
    const check = await supabase.auth.signInWithPassword({ email, password: current });
    if (check.error) { setStatus("Current password is incorrect."); setBusy(false); return; }
    const { error } = await supabase.auth.updateUser({ password: next });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setCurrent(""); setNext(""); setConfirmPassword(""); setStatus("Password updated.");
  }

  return <div className="settings-block">
    <p className="card-kicker">Password</p>
    <form onSubmit={submit} className="household-form">
      <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} disabled={busy} /></label>
      <label>New password<input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(event) => setNext(event.target.value)} disabled={busy} /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} /></label>
      <button disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
  </div>;
}

type TotpFactor = { id: string; status: string };
type Passkey = { id: string; friendly_name: string | null; created_at: string; last_used_at: string | null };

function PasskeySection() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.auth.passkey.list();
    if (!error) setPasskeys((data as unknown as Passkey[]) ?? []);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function addPasskey() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.auth.registerPasskey();
    setBusy(false);
    if (error) { setMessage(error.message || "We could not add that passkey."); return; }
    setMessage("Passkey added.");
    await load();
  }

  async function removePasskey(passkeyId: string) {
    if (!confirm("Remove this passkey? You will need another way to sign in with it removed.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.passkey.delete({ passkeyId });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    await load();
  }

  if (loading) return null;

  return <div className="settings-block">
    <p className="card-kicker">Passkeys</p>
    <p className="portal-empty">Sign in with your device’s biometrics or security key instead of typing a password.</p>
    {passkeys.map((key) => <div className="member-row" key={key.id}>
      <div><b>{key.friendly_name || "Passkey"}</b><span style={{ display: "block", fontSize: 11, color: "var(--sage)" }}>Added {new Date(key.created_at).toLocaleDateString()}{key.last_used_at ? ` · last used ${new Date(key.last_used_at).toLocaleDateString()}` : ""}</span></div>
      <div className="row-actions"><button className="danger" onClick={() => removePasskey(key.id)} disabled={busy}>Remove</button></div>
    </div>)}
    <button onClick={addPasskey} disabled={busy} style={{ marginTop: passkeys.length ? 14 : 0 }}>{busy ? "Working…" : "Add a passkey"}</button>
    <p className="admin-form-status" role="status">{message}</p>
  </div>;
}

function TwoFactorSection() {
  const [status, setStatus] = useState<"loading" | "enrolled" | "enrolling" | "disabled">("loading");
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.mfa.listFactors();
    const verified = (data?.totp as TotpFactor[] | undefined)?.find((factor) => factor.status === "verified");
    setStatus(verified ? "enrolled" : "disabled");
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function startEnroll() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setFactorId(data.id); setQr(data.totp.qr_code); setStatus("enrolling");
  }

  async function verify() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) { setMessage(challenge.error.message); setBusy(false); return; }
    const verifyResult = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    setBusy(false);
    if (verifyResult.error) { setMessage(verifyResult.error.message); return; }
    setCode(""); setStatus("enrolled"); setMessage("Two-factor authentication is now on.");
  }

  async function disable() {
    if (!confirm("Turn off two-factor authentication?")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { data } = await supabase.auth.mfa.listFactors();
    const verified = (data?.totp as TotpFactor[] | undefined)?.find((factor) => factor.status === "verified");
    if (verified) await supabase.auth.mfa.unenroll({ factorId: verified.id });
    setBusy(false);
    await load();
  }

  if (status === "loading") return null;

  return <div className="settings-block">
    <p className="card-kicker">Two-factor authentication</p>
    {status === "disabled" && <>
      <p className="portal-empty">Add a one-time code from an authenticator app for extra security when signing in.</p>
      <button onClick={startEnroll} disabled={busy}>Set up two-factor authentication</button>
    </>}
    {status === "enrolling" && <div className="mfa-enroll">
      {qr && <img src={qr} alt="Scan this QR code with your authenticator app" style={{ width: 180, height: 180 }} />}
      <label>Enter the 6-digit code from your app<input value={code} onChange={(event) => setCode(event.target.value.trim())} maxLength={6} disabled={busy} /></label>
      <button onClick={verify} disabled={busy}>Confirm</button>
    </div>}
    {status === "enrolled" && <>
      <p className="portal-empty">Two-factor authentication is on.</p>
      <button className="danger" onClick={disable} disabled={busy}>Turn off</button>
    </>}
    <p className="admin-form-status" role="status">{message}</p>
  </div>;
}

function DangerZone({ onSignOut }: { onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function deleteAccount() {
    if (!confirm("Delete your account? You will lose access immediately. This cannot be undone by you — contact a Village administrator to restore access.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { data } = await supabase.auth.getUser();
    if (!data.user) { setBusy(false); return; }
    const { error } = await supabase.from("profiles").update({ status: "removed" }).eq("id", data.user.id);
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    onSignOut();
  }

  return <div className="settings-block danger-zone">
    <p className="card-kicker">Delete account</p>
    <p className="portal-empty">This removes your access to Family Village. Your household and children’s records stay intact for the co-op; an administrator can restore your access later if needed.</p>
    <button className="danger" onClick={deleteAccount} disabled={busy}>Delete my account</button>
    <p className="admin-form-status" role="status">{status}</p>
  </div>;
}
