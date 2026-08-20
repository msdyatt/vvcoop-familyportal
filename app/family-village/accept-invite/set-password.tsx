"use client";
import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
export default function AcceptInvite() {
  const [ready, setReady] = useState(false); const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState(""); const [message, setMessage] = useState("Opening your invitation…"); const [busy, setBusy] = useState(false);
  useEffect(() => { getSupabaseBrowserClient()?.auth.getUser().then(({ data }) => { setReady(Boolean(data.user)); setMessage(data.user ? "Choose the password you will use for Family Village." : "This invitation is invalid or has expired. Ask a Village administrator for a new invitation."); }); }, []);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (password !== confirm) { setMessage("The passwords do not match."); return; } setBusy(true); const { error } = await getSupabaseBrowserClient()!.auth.updateUser({ password }); if (error) { setMessage(error.message); setBusy(false); return; } window.location.assign("/family-village/home"); }
  return <main className="accept-invite"><section><p className="eyebrow">Welcome to Family Village</p><h1>Your place<br/><em>at the table.</em></h1><p>{message}</p>{ready && <form onSubmit={save}><label>New password<input type="password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/></label><label>Confirm password<input type="password" minLength={8} required value={confirm} onChange={event => setConfirm(event.target.value)} disabled={busy}/></label><button disabled={busy}>{busy ? "Opening your village…" : "Set password and enter"}</button></form>}<a href="/family-village">Return to sign in →</a></section></main>;
}
