"use client";

import { useState } from "react";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";

type Credential = { role: string; email: string; password: string };

/**
 * Reviewer accounts for the App Store and Google Play. The store reviewers
 * must sign in, and they must not see real families, so these two accounts live
 * in a sealed sample world (see the demo_accounts migration). Passwords are
 * generated on the server, shown here once, and stored nowhere.
 */
export default function DemoAccountsCard() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  async function run(action: "create" | "remove") {
    if (action === "remove" && !confirm("Remove the reviewer accounts and all of their sample data? Reviewers who are still testing will lose access.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    setStatus(action === "create" ? "Creating the reviewer accounts…" : "Removing the reviewer accounts…");
    const { data, error } = await supabase.functions.invoke("demo-accounts", { body: { action } });
    setBusy(false);
    if (error || !data?.ok) { setStatus(await functionErrorMessage(error, data, "Something went wrong.")); return; }
    if (action === "create") {
      setCredentials(data.accounts as Credential[]);
      setStatus("Reviewer accounts are ready. Copy the passwords now; they are not shown again.");
    } else {
      setCredentials([]);
      setStatus("Reviewer accounts removed.");
    }
  }

  async function copy(key: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1500); } catch { setStatus("Copying was blocked. Select the text and copy it by hand."); }
  }

  return <article className="integration-card">
    <div className="integration-card-head"><h3>App store reviewer accounts</h3></div>
    <p className="field-note">Apple and Google reviewers need to sign in. These two accounts, a demo parent and a demo teacher, see only made-up sample content (a sample class, posts, an event and messages) and never any real family. Creating them again resets both passwords and the sample data.</p>
    <div className="field-row">
      <button type="button" disabled={busy} onClick={() => run("create")}>Create or reset reviewer accounts</button>
      <button type="button" className="ghost" disabled={busy} onClick={() => run("remove")}>Remove them</button>
    </div>
    {status && <p className="admin-form-status" role="status">{status}</p>}
    {credentials.length > 0 && <div className="demo-credentials">
      {credentials.map((c) => <div key={c.role} className="demo-credential">
        <p><b>{c.role === "parent" ? "Demo parent" : "Demo teacher"}</b></p>
        <p>Email: <code>{c.email}</code> <button type="button" className="ghost" onClick={() => copy(`${c.role}-email`, c.email)}>{copied === `${c.role}-email` ? "Copied" : "Copy"}</button></p>
        <p>Password: <code>{c.password}</code> <button type="button" className="ghost" onClick={() => copy(`${c.role}-pw`, c.password)}>{copied === `${c.role}-pw` ? "Copied" : "Copy"}</button></p>
      </div>)}
    </div>}
  </article>;
}
