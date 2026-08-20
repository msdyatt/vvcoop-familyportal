"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../../lib/supabase";

export default function SignInPanel() {
  const configured = isSupabaseConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) window.location.assign("/family-village/home");
    });
  }, []);

  async function social(provider: "google" | "apple") {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: `${window.location.origin}/family-village/home` } });
    if (error) { setMessage(error.message); setBusy(false); }
  }

  async function emailSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setMessage("We could not sign you in. Check your details or contact a Village administrator."); setBusy(false); return; }
    window.location.assign("/family-village/home");
  }

  return <div className="signin-stack" aria-label="Family Village sign-in">
    <button type="button" disabled={!configured || busy} onClick={() => social("google")}><span>G</span> Continue with Google</button>
    <button type="button" disabled={!configured || busy} onClick={() => social("apple")}><span>●</span> Continue with Apple</button>
    <div className="signin-divider"><span>or use your invitation email</span></div>
    <form onSubmit={emailSignIn} className="email-signin">
      <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={!configured || busy}/></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={!configured || busy}/></label>
      <button type="submit" disabled={!configured || busy}><span>✉</span> Sign in with email</button>
    </form>
    <p className="setup-note" role="status">{message || (configured ? "Access is granted by invitation and administrator approval." : "The secure Supabase project connection is required before sign-in can open.")}</p>
  </div>;
}
