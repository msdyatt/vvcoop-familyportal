"use client";
import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";
import { usePortalAccess } from "../../../lib/use-portal-access";
import MfaChallengeScreen from "../mfa-challenge";
import AppHeader from "../app-header";
import AdminDashboard from "./dashboard";

// Every tab used to be a static import, so an admin session downloaded all
// eight tabs' code (and everything they pull in -- rich text, CSV export,
// OpenSign/Resend integration wiring...) up front, before ever opening one.
// AdminDashboard stays eager since it's what actually renders first; the
// other seven only cost bytes once someone clicks their tab.
const FamiliesTab = dynamic(() => import("./families-tab"));
const NewsTab = dynamic(() => import("./news-tab"));
const ClassesTab = dynamic(() => import("./classes-tab"));
const IntegrationsTab = dynamic(() => import("./integrations-tab"));
const ActivityTab = dynamic(() => import("./activity-tab"));
const ComplianceTab = dynamic(() => import("./compliance-tab"));
const ReportsTab = dynamic(() => import("./reports-tab"));

type Invitation = { id: string; email: string; expires_at: string; accepted_at: string | null; families: { display_name: string } | null };
type Tab = "dashboard" | "invitations" | "families" | "classes" | "compliance" | "news" | "reports" | "activity" | "integrations";

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

export default function AdminWorkspace() {
  const { state: access, userId, roles, recheck } = usePortalAccess("admin");
  const [tab, setTab] = useState<Tab>("dashboard");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [familyName, setFamilyName] = useState(""); const [adminName, setAdminName] = useState(""); const [email, setEmail] = useState(""); const [note, setNote] = useState("");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function loadInvitations() { const supabase = getSupabaseBrowserClient(); if (!supabase) return; const { data } = await supabase.from("invitations").select("id,email,expires_at,accepted_at,families(display_name)").order("created_at", { ascending: false }).limit(8); setInvitations((data ?? []) as unknown as Invitation[]); }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch once access resolves
  useEffect(() => { if (access === "ready") loadInvitations(); }, [access]);
  async function invite(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const supabase = getSupabaseBrowserClient(); if (!supabase) return; setBusy(true); setMessage(""); const { data, error } = await supabase.functions.invoke("invite-family-admin", { body: { familyName, adminName, email, note } }); setBusy(false); if (error || data?.error) { setMessage(await functionErrorMessage(error, data, "The invitation could not be sent. Check the email service configuration and try again.")); return; } setMessage(data?.warning ?? `Invitation sent to ${email}. The link expires in 24 hours.`); setFamilyName(""); setAdminName(""); setEmail(""); setNote(""); await loadInvitations(); }
  if (access === "loading") return <main className="portal-state"><p className="eyebrow">Village administration</p><h1>Checking your stewardship access…</h1></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private administrator workspace</p><h1>Administrator access is required.</h1><a href="/family-village">Return to Family Village →</a></main>;
  return <main className="admin-live">
    <AppHeader current="admin" roles={roles} title="Village administration" subtitle="Invite families, manage rosters, and publish news." />
    <label className="admin-mobile-nav"><span>Admin section</span><select value={tab} onChange={(event) => setTab(event.target.value as Tab)}>
      <option value="dashboard">Dashboard</option><option value="invitations">Invitations</option><option value="families">Families</option><option value="classes">Classes</option><option value="compliance">Compliance</option><option value="news">News &amp; calendar</option><option value="reports">Reports</option><option value="activity">Activity</option><option value="integrations">Integrations</option>
    </select></label>
    <div className="admin-workspace-layout">
    <nav className="admin-tabs" aria-label="Administration sections">
      <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
      <button className={tab === "invitations" ? "active" : ""} onClick={() => setTab("invitations")}>Invitations</button>
      <button className={tab === "families" ? "active" : ""} onClick={() => setTab("families")}>Families</button>
      <button className={tab === "classes" ? "active" : ""} onClick={() => setTab("classes")}>Classes</button>
      <button className={tab === "compliance" ? "active" : ""} onClick={() => setTab("compliance")}>Compliance</button>
      <button className={tab === "news" ? "active" : ""} onClick={() => setTab("news")}>News &amp; calendar</button>
      <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>Reports</button>
      <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity</button>
      <button className={tab === "integrations" ? "active" : ""} onClick={() => setTab("integrations")}>Integrations</button>
    </nav>
    <div className="admin-workspace-main">

    {tab === "dashboard" && <AdminDashboard onNavigate={setTab} />}

    {tab === "invitations" && <>
      <div className="admin-invite-layout"><section className="admin-invite-card"><p className="card-kicker">New household invitation</p><h2>Who are we welcoming?</h2><form onSubmit={invite} className="admin-invite-form"><label>Family or household name<input required value={familyName} onChange={event => setFamilyName(event.target.value)} placeholder="The Lewis family" disabled={busy}/></label><label>Family administrator’s name<input required value={adminName} onChange={event => setAdminName(event.target.value)} placeholder="Jordan Lewis" disabled={busy}/></label><label>Email address<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="jordan@example.com" disabled={busy}/></label><label>Personal note <span>optional</span><textarea value={note} onChange={event => setNote(event.target.value)} placeholder="A short welcome from the Village…" disabled={busy}/></label><button disabled={busy}>{busy ? "Preparing invitation…" : "Send family invitation"}</button></form><p className="admin-form-status" role="status">{message || "The recipient will set a private password and enter as the administrator for this household."}</p></section><aside className="invitation-letter-preview"><p className="card-kicker">Email preview</p><div className="email-paper"><Image className="email-logo" src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} /><span className="email-rule"/><p>You’re invited</p><h2>There is a place for your family at the table.</h2><p>Hello {adminName || "friend"},</p><p>You have been invited to join Family Village, the private home for Veritas Village families.</p>{note && <blockquote>{note}</blockquote>}<span className="email-button">Accept your invitation</span><small>This private link expires in 24 hours.</small></div></aside></div>
      <section className="recent-invitations"><p className="eyebrow">Recent invitations</p><h2>Invitations in motion</h2>{invitations.length ? <div>{invitations.map(item => <article key={item.id}><div><b>{item.families?.display_name ?? "Household"}</b><span>{item.email}</span></div><span className={item.accepted_at ? "accepted" : "pending"}>{item.accepted_at ? "Accepted" : new Date(item.expires_at) < new Date() ? "Expired" : "Awaiting response"}</span></article>)}</div> : <p>No invitations have been sent yet.</p>}</section>
    </>}

    {tab === "families" && <FamiliesTab actorUserId={userId} />}
    {tab === "classes" && <ClassesTab actorUserId={userId} />}
    {tab === "compliance" && <ComplianceTab actorUserId={userId} />}
    {tab === "news" && <NewsTab actorUserId={userId} />}
    {tab === "reports" && <ReportsTab />}
    {tab === "activity" && <ActivityTab />}
    {tab === "integrations" && <IntegrationsTab actorUserId={userId} />}
    </div>
    </div>
  </main>;
}
