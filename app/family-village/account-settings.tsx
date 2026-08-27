"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../lib/storage";
import SubscribeLink from "./subscribe-link";
import Avatar from "./avatar";
import AvatarCropper from "./avatar-cropper";

export default function AccountSettings({ email, onSignOut, onProfileUpdated }: { email: string; onSignOut: () => void; onProfileUpdated?: () => void }) {
  return <div className="account-settings">
    <ContactSection onProfileUpdated={onProfileUpdated} />
    <PasswordSection email={email} />
    <PasskeySection />
    <TwoFactorSection />
    <CalendarSection />
    <DangerZone onSignOut={onSignOut} />
  </div>;
}

/**
 * Everything on the family/teaching calendars this account can see, as a
 * feed any calendar app can subscribe to. The regenerate control lives only
 * here, not on the inline subscribe links elsewhere in the app -- a leaked
 * link is invalidated by getting a new one, and that's a deliberate account
 * action, not something to have crowding a "here's your calendar" widget.
 */
function CalendarSection() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data } = await supabase.from("profiles").select("calendar_token").eq("id", user.user.id).single();
      setToken(data?.calendar_token ?? null);
    }
    load();
  }, []);

  async function regenerate() {
    if (!confirm("Get a new link? The old one will stop working.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("regenerate_calendar_token");
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setToken(data as string);
    setMessage("New link ready.");
  }

  if (!token) return null;
  return <div className="settings-block">
    <p className="card-kicker">Calendar</p>
    <p className="portal-empty">A live feed of your classes and events, for your phone or computer&rsquo;s calendar app.</p>
    <SubscribeLink query={`scope=personal&token=${token}`} label="Subscribe to your calendar" />
    <div className="row-actions">
      <button type="button" className="ghost" onClick={regenerate} disabled={busy}>{busy ? "Working…" : "Get a new link"}</button>
    </div>
    <p className="admin-form-status" role="status">{message}</p>
  </div>;
}

/**
 * Name and contact details. Display name used to live in a "Household settings"
 * module on the family dashboard, which put an account setting on a page about
 * the week ahead; it belongs here with the rest of the account, and it saves in
 * the same round trip as the contact fields rather than needing its own form.
 */
function ContactSection({ onProfileUpdated }: { onProfileUpdated?: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [emergencyName, setEmergencyName] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState("");
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    const { data: profile } = await supabase.from("profiles").select("display_name,phone,emergency_contact_name,emergency_contact_phone,avatar_path").eq("id", data.user.id).single();
    setDisplayName(profile?.display_name ?? "");
    setPhone(profile?.phone ?? ""); setEmergencyName(profile?.emergency_contact_name ?? ""); setEmergencyPhone(profile?.emergency_contact_phone ?? "");
    setAvatarUrl(profile?.avatar_path ? await getSignedFileUrl(supabase, profile.avatar_path) : null);
    setLoading(false);
  }

  async function uploadAvatar(file: File) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setAvatarBusy(true); setAvatarStatus("Uploading…");
    const { data } = await supabase.auth.getUser();
    if (!data.user) { setAvatarBusy(false); return; }
    const uploaded = await uploadPrivateFile(supabase, "avatars", file);
    if ("error" in uploaded) { setAvatarBusy(false); setAvatarStatus(uploaded.error); return; }
    const { error } = await supabase.from("profiles").update({ avatar_path: uploaded.path }).eq("id", data.user.id);
    setAvatarBusy(false);
    if (error) { setAvatarStatus(error.message); return; }
    setAvatarStatus("Photo updated.");
    setPendingAvatar(null);
    await load();
    onProfileUpdated?.();
  }

  /**
   * Re-opens the cropper on the photo already saved, rather than only
   * offering "pick a new file" -- the cropper only works on a File object it
   * has in hand, so this re-fetches the current signed image and wraps it as
   * one, the same shape a fresh upload would produce.
   */
  async function editExisting() {
    if (!avatarUrl) return;
    setAvatarStatus("Opening your photo…");
    try {
      const response = await fetch(avatarUrl);
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      setPendingAvatar(new File([blob], "current-avatar.jpg", { type: blob.type || "image/jpeg" }));
      setAvatarStatus("");
    } catch {
      setAvatarStatus("Could not open the current photo for editing.");
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus("");
    const { data } = await supabase.auth.getUser();
    if (!data.user) { setBusy(false); return; }
    const { error } = await supabase.from("profiles").update({
      display_name: displayName.trim() || null,
      phone: phone.trim() || null,
      emergency_contact_name: emergencyName.trim() || null,
      emergency_contact_phone: emergencyPhone.trim() || null,
    }).eq("id", data.user.id);
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setStatus("Saved.");
    onProfileUpdated?.();
  }

  if (loading) return null;

  return <div className="settings-block">
    <p className="card-kicker">Your details</p>
    <div className="avatar-uploader">
      <Avatar url={avatarUrl} label={displayName || "?"} size="lg" />
      <div>
        <label className="file-drop"><span className="field-caption">{avatarUrl ? "Replace photo" : "Photo"}</span>
          <input type="file" accept="image/*" disabled={avatarBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) setPendingAvatar(file); event.currentTarget.value = ""; }} />
        </label>
        {avatarUrl && <button type="button" className="ghost" onClick={editExisting} disabled={avatarBusy}>Edit crop</button>}
        <p className="admin-form-status" role="status">{avatarStatus}</p>
      </div>
    </div>
    {pendingAvatar && <AvatarCropper file={pendingAvatar} busy={avatarBusy} onCancel={() => setPendingAvatar(null)} onSave={uploadAvatar} />}
    <form onSubmit={submit} className="household-form">
      <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="How your name appears in the Village" disabled={busy} /></label>
      <label>Phone number<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 555-5555" disabled={busy} /></label>
      <label>Emergency contact name<input value={emergencyName} onChange={(event) => setEmergencyName(event.target.value)} disabled={busy} /></label>
      <label>Emergency contact phone<input type="tel" value={emergencyPhone} onChange={(event) => setEmergencyPhone(event.target.value)} disabled={busy} /></label>
      <button disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
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
