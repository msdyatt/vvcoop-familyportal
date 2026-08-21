"use client";
import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import PortalNav from "../portal-nav";
import FamiliesTab from "./families-tab";
import NewsTab from "./news-tab";
import ClassesTab from "./classes-tab";
import IntegrationsTab from "./integrations-tab";

type AccessState = "loading" | "denied" | "ready";
type Invitation = { id: string; email: string; expires_at: string; accepted_at: string | null; families: { display_name: string } | null };
type Tab = "invitations" | "families" | "classes" | "news" | "integrations";

export default function AdminWorkspace() {
  const [access, setAccess] = useState<AccessState>(() => getSupabaseBrowserClient() ? "loading" : "denied");
  const [userId, setUserId] = useState<string>("");
  const [roles, setRoles] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("invitations");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [familyName, setFamilyName] = useState(""); const [adminName, setAdminName] = useState(""); const [email, setEmail] = useState(""); const [note, setNote] = useState("");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function loadInvitations() { const supabase = getSupabaseBrowserClient(); if (!supabase) return; const { data } = await supabase.from("invitations").select("id,email,expires_at,accepted_at,families(display_name)").order("created_at", { ascending: false }).limit(8); setInvitations((data ?? []) as unknown as Invitation[]); }
  useEffect(() => {
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setAccess("denied"); return; }
      const [{ data: profile }, { data: role }, { data: allRoles }] = await Promise.all([
        supabase.from("profiles").select("status").eq("id", data.user.id).single(),
        supabase.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "admin").maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", data.user.id),
      ]);
      if (profile?.status !== "active" || !role) { setAccess("denied"); return; }
      setUserId(data.user.id);
      setRoles((allRoles ?? []).map((item) => item.role));
      setAccess("ready");
      await loadInvitations();
    });
  }, []);
  async function invite(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const supabase = getSupabaseBrowserClient(); if (!supabase) return; setBusy(true); setMessage(""); const { data, error } = await supabase.functions.invoke("invite-family-admin", { body: { familyName, adminName, email, note } }); setBusy(false); if (error || data?.error) { setMessage(data?.error || "The invitation could not be sent. Check the email service configuration and try again."); return; } setMessage(`Invitation sent to ${email}. The link expires in one hour.`); setFamilyName(""); setAdminName(""); setEmail(""); setNote(""); await loadInvitations(); }
  if (access === "loading") return <main className="portal-state"><p className="eyebrow">Village administration</p><h1>Checking your stewardship access…</h1></main>;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private administrator workspace</p><h1>Administrator access is required.</h1><a href="/family-village">Return to Family Village →</a></main>;
  return <main className="admin-live">
    <header className="admin-live-head">
      <div><p className="eyebrow">Village administration</p><h1>Run the village,<br /><em>one household at a time.</em></h1><p>Invite families, keep household and roster records accurate, and publish news to the co-op.</p></div>
      <PortalNav current="admin" roles={roles} />
    </header>
    <nav className="admin-tabs">
      <button className={tab === "invitations" ? "active" : ""} onClick={() => setTab("invitations")}>Invitations</button>
      <button className={tab === "families" ? "active" : ""} onClick={() => setTab("families")}>Families</button>
      <button className={tab === "classes" ? "active" : ""} onClick={() => setTab("classes")}>Classes</button>
      <button className={tab === "news" ? "active" : ""} onClick={() => setTab("news")}>Village news</button>
      <button className={tab === "integrations" ? "active" : ""} onClick={() => setTab("integrations")}>Integrations</button>
    </nav>

    {tab === "invitations" && <>
      <div className="admin-invite-layout"><section className="admin-invite-card"><p className="card-kicker">New household invitation</p><h2>Who are we welcoming?</h2><form onSubmit={invite} className="admin-invite-form"><label>Family or household name<input required value={familyName} onChange={event => setFamilyName(event.target.value)} placeholder="The Lewis family" disabled={busy}/></label><label>Family administrator’s name<input required value={adminName} onChange={event => setAdminName(event.target.value)} placeholder="Jordan Lewis" disabled={busy}/></label><label>Email address<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="jordan@example.com" disabled={busy}/></label><label>Personal note <span>optional</span><textarea value={note} onChange={event => setNote(event.target.value)} placeholder="A short welcome from the Village…" disabled={busy}/></label><button disabled={busy}>{busy ? "Preparing invitation…" : "Send family invitation"}</button></form><p className="admin-form-status" role="status">{message || "The recipient will set a private password and enter as the administrator for this household."}</p></section><aside className="invitation-letter-preview"><p className="card-kicker">Email preview</p><div className="email-paper"><p className="email-vv">VERITAS VILLAGE</p><span className="email-rule"/><p>You’re invited</p><h2>There is a place for your family at the table.</h2><p>Hello {adminName || "friend"},</p><p>You have been invited to join Family Village, the private home for Veritas Village families.</p>{note && <blockquote>{note}</blockquote>}<span className="email-button">Accept your invitation</span><small>This private link expires in one hour.</small></div></aside></div>
      <section className="recent-invitations"><p className="eyebrow">Recent invitations</p><h2>Invitations in motion</h2>{invitations.length ? <div>{invitations.map(item => <article key={item.id}><div><b>{item.families?.display_name ?? "Household"}</b><span>{item.email}</span></div><span className={item.accepted_at ? "accepted" : "pending"}>{item.accepted_at ? "Accepted" : new Date(item.expires_at) < new Date() ? "Expired" : "Awaiting response"}</span></article>)}</div> : <p>No invitations have been sent yet.</p>}</section>
    </>}

    {tab === "families" && <FamiliesTab actorUserId={userId} />}
    {tab === "classes" && <ClassesTab />}
    {tab === "news" && <NewsTab actorUserId={userId} />}
    {tab === "integrations" && <IntegrationsTab actorUserId={userId} />}
  </main>;
}
