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
const MessageReportsTab = dynamic(() => import("./message-reports-tab"));
const ComplianceTab = dynamic(() => import("./compliance-tab"));
const ReportsTab = dynamic(() => import("./reports-tab"));
const DuesTab = dynamic(() => import("./dues-tab"));

type Invitation = { id: string; email: string; expires_at: string; accepted_at: string | null; families: { display_name: string } | null };
const TABS = ["dashboard", "invitations", "families", "classes", "compliance", "dues", "news", "reports", "activity", "message-reports", "integrations"] as const;
type Tab = (typeof TABS)[number];

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

export default function AdminWorkspace() {
  const { state: access, userId, roles, recheck } = usePortalAccess("admin");
  // The bottom bar links straight to a tab with ?tab=, so read it once on load.
  const [tab, setTabState] = useState<Tab>(() => {
    if (typeof window === "undefined") return "dashboard";
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return (TABS as readonly string[]).includes(wanted ?? "") ? (wanted as Tab) : "dashboard";
  });
  function setTab(next: Tab) {
    setTabState(next);
    // Keep the address (and the bottom bar's highlight) in step with the tab.
    window.history.replaceState(null, "", next === "dashboard" ? window.location.pathname : `?tab=${next}`);
    window.dispatchEvent(new Event("vv-locationchange"));
  }
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [familyName, setFamilyName] = useState(""); const [adminName, setAdminName] = useState(""); const [email, setEmail] = useState(""); const [note, setNote] = useState("");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const [rowBusy, setRowBusy] = useState<string | null>(null); const [listMessage, setListMessage] = useState("");
  async function loadInvitations() { const supabase = getSupabaseBrowserClient(); if (!supabase) return; const { data } = await supabase.from("invitations").select("id,email,expires_at,accepted_at,families(display_name)").order("created_at", { ascending: false }).limit(25); setInvitations((data ?? []) as unknown as Invitation[]); }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch once access resolves
  useEffect(() => { if (access === "ready") loadInvitations(); }, [access]);
  async function manageInvitation(item: Invitation, action: "resend" | "delete") {
    const expired = new Date(item.expires_at) < new Date();
    if (action === "delete" && !confirm(`Delete the invitation for ${item.email}? Their pending account is removed, and so is the household if it has no one else and no children.`)) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    setRowBusy(item.id); setListMessage("");
    const { data, error } = await supabase.functions.invoke("invite-family-admin", { body: { action, invitationId: item.id } });
    setRowBusy(null);
    if (error || data?.error) { setListMessage(await functionErrorMessage(error, data, action === "resend" ? "The invitation could not be resent." : "The invitation could not be deleted.")); return; }
    setListMessage(action === "resend"
      ? (data?.warning ?? `${expired ? "A new link" : "The invitation"} was sent to ${item.email}. It expires in 24 hours.`)
      : `Deleted the invitation for ${item.email}${data?.householdRemoved ? " and the empty household." : "."}`);
    await loadInvitations();
  }
  async function invite(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const supabase = getSupabaseBrowserClient(); if (!supabase) return; setBusy(true); setMessage(""); const { data, error } = await supabase.functions.invoke("invite-family-admin", { body: { familyName, adminName, email, note } }); setBusy(false); if (error || data?.error) { setMessage(await functionErrorMessage(error, data, "The invitation could not be sent. Check the email service configuration and try again.")); return; } setMessage(data?.warning ?? `Invitation sent to ${email}. The link expires in 24 hours.`); setFamilyName(""); setAdminName(""); setEmail(""); setNote(""); await loadInvitations(); }
  if (access === "loading") return <main className="portal-state"><p className="eyebrow">Village administration</p><h1>Checking your stewardship access…</h1></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private administrator workspace</p><h1>Administrator access is required.</h1><a href="/family-village">Return to Family Village →</a></main>;
  return <main className="admin-live">
    <AppHeader current="admin" roles={roles} title="Village administration" subtitle="Invite families, manage rosters, and publish news." />
    <label className="admin-mobile-nav"><span>Admin section</span><select value={tab} onChange={(event) => setTab(event.target.value as Tab)}>
      <option value="dashboard">Dashboard</option><option value="invitations">Invitations</option><option value="families">Families</option><option value="classes">Classes</option><option value="compliance">Compliance</option><option value="dues">Dues</option><option value="news">News &amp; calendar</option><option value="reports">Reports</option><option value="activity">Activity</option><option value="message-reports">Messaging</option><option value="integrations">Integrations</option>
    </select></label>
    <div className="admin-workspace-layout">
    <nav className="admin-tabs" aria-label="Administration sections">
      <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
      <button className={tab === "invitations" ? "active" : ""} onClick={() => setTab("invitations")}>Invitations</button>
      <button className={tab === "families" ? "active" : ""} onClick={() => setTab("families")}>Families</button>
      <button className={tab === "classes" ? "active" : ""} onClick={() => setTab("classes")}>Classes</button>
      <button className={tab === "compliance" ? "active" : ""} onClick={() => setTab("compliance")}>Compliance</button>
      <button className={tab === "dues" ? "active" : ""} onClick={() => setTab("dues")}>Dues</button>
      <button className={tab === "news" ? "active" : ""} onClick={() => setTab("news")}>News &amp; calendar</button>
      <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>Reports</button>
      <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity</button>
      <button className={tab === "message-reports" ? "active" : ""} onClick={() => setTab("message-reports")}>Messaging</button>
      <button className={tab === "integrations" ? "active" : ""} onClick={() => setTab("integrations")}>Integrations</button>
    </nav>
    <div className="admin-workspace-main">

    {tab === "dashboard" && <AdminDashboard onNavigate={setTab} />}

    {tab === "invitations" && <>
      <div className="admin-invite-layout"><section className="admin-invite-card"><p className="card-kicker">New household invitation</p><h2>Who are we welcoming?</h2><form onSubmit={invite} className="admin-invite-form"><label>Family or household name<input required value={familyName} onChange={event => setFamilyName(event.target.value)} placeholder="The Lewis family" disabled={busy}/></label><label>Family administrator’s name<input required value={adminName} onChange={event => setAdminName(event.target.value)} placeholder="Jordan Lewis" disabled={busy}/></label><label>Email address<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="jordan@example.com" disabled={busy}/></label><label>Personal note <span>optional</span><textarea value={note} onChange={event => setNote(event.target.value)} placeholder="A short welcome from the Village…" disabled={busy}/></label><button disabled={busy}>{busy ? "Preparing invitation…" : "Send family invitation"}</button></form><p className="admin-form-status" role="status">{message || "The recipient will set a private password and enter as the administrator for this household."}</p></section><aside className="invitation-letter-preview"><p className="card-kicker">Email preview</p><div className="email-paper"><Image className="email-logo" src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} /><span className="email-rule"/><p>You’re invited</p><h2>There is a place for your family at the table.</h2><p>Hello {adminName || "friend"},</p><p>You have been invited to join Family Village, the private home for Veritas Village families.</p>{note && <blockquote>{note}</blockquote>}<span className="email-button">Accept your invitation</span><small>This private link expires in 24 hours.</small></div></aside></div>
      <section className="recent-invitations"><p className="eyebrow">Recent invitations</p><h2>Invitations in motion</h2><p className="admin-form-status" role="status">{listMessage}</p>{invitations.length ? <div>{invitations.map(item => <article key={item.id}><div><b>{item.families?.display_name ?? "Household"}</b><span>{item.email}</span></div><span className={item.accepted_at ? "accepted" : "pending"}>{item.accepted_at ? "Accepted" : new Date(item.expires_at) < new Date() ? "Expired" : "Awaiting response"}</span>{!item.accepted_at && <div className="invitation-actions"><button type="button" className="ghost" disabled={rowBusy === item.id} onClick={() => manageInvitation(item, "resend")}>{rowBusy === item.id ? "Working…" : new Date(item.expires_at) < new Date() ? "Send a new link" : "Resend"}</button><button type="button" className="danger" disabled={rowBusy === item.id} onClick={() => manageInvitation(item, "delete")}>Delete</button></div>}</article>)}</div> : <p>No invitations have been sent yet.</p>}</section>
    </>}

    {tab === "families" && <FamiliesTab actorUserId={userId} />}
    {tab === "classes" && <ClassesTab actorUserId={userId} />}
    {tab === "compliance" && <ComplianceTab actorUserId={userId} />}
    {tab === "dues" && <DuesTab actorUserId={userId} />}
    {tab === "news" && <NewsTab actorUserId={userId} />}
    {tab === "reports" && <ReportsTab />}
    {tab === "activity" && <ActivityTab />}
    {tab === "message-reports" && <MessageReportsTab />}
    {tab === "integrations" && <IntegrationsTab actorUserId={userId} />}
    </div>
    </div>
  </main>;
}
