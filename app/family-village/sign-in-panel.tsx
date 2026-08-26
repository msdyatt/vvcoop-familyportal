"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../../lib/supabase";

export default function SignInPanel() {
  const configured = isSupabaseConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "request">("sign-in");

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) window.location.assign("/family-village/home");
    });
  }, []);

  // Google/Apple sign-in was removed at Sam's request (username/password
  // only). Passkeys were never part of that ask -- restored after being
  // dropped along with the OAuth buttons in an earlier pass.
  async function passkey() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.auth.signInWithPasskey();
    if (error) { setMessage(error.message || "We could not sign you in with a passkey. Try email instead."); setBusy(false); return; }
    window.location.assign("/family-village/home");
  }

  async function emailSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    if (mode === "request") {
      const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/family-village/home` } });
      setBusy(false);
      if (error) { setMessage("We could not create that account. Try a different password or contact a Village administrator."); return; }
      setMessage("Check your email to verify your address. After that, a Village administrator will connect your family before private information appears.");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setMessage("We could not sign you in. Check your details or contact a Village administrator."); setBusy(false); return; }
    window.location.assign("/family-village/home");
  }

  return <div className="signin-stack" aria-label="Family Village sign-in">
    <button type="button" className="passkey-button" disabled={!configured || busy} onClick={passkey}><span>🔐</span> Sign in with a passkey</button>
    <div className="signin-divider"><span>or use your invitation email</span></div>
    <form onSubmit={emailSignIn} className="email-signin">
      <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={!configured || busy}/></label>
      <label>Password<input type="password" minLength={8} autoComplete={mode === "request" ? "new-password" : "current-password"} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={!configured || busy}/></label>
      <button type="submit" disabled={!configured || busy}>{mode === "request" ? "Request family access" : "Sign in"}</button>
    </form>
    <button className="mode-switch" type="button" disabled={!configured || busy} onClick={() => { setMode(mode === "sign-in" ? "request" : "sign-in"); setMessage(""); }}>
      {mode === "sign-in" ? "First time here? Request an account" : "Already approved? Return to sign in"}
    </button>
    <p className="setup-note" role="status">{message || (configured ? "Access is granted by invitation and administrator approval." : "The secure Supabase project connection is required before sign-in can open.")}</p>
  </div>;
}
