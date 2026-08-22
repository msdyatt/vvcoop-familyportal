"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../../../lib/supabase";
import { getSignedFileUrl } from "../../../lib/storage";
import ChildDetail from "../child-detail";
import DetailModal from "../detail-modal";
import AppHeader from "../app-header";
import MfaChallengeScreen from "../mfa-challenge";
import { ComplianceBanner, CompliancePanel, ComplianceItem } from "../compliance-panel";
import { FamilyRequirement, Requirement } from "../../../lib/compliance";

type PortalState = "loading" | "signed-out" | "mfa-challenge" | "pending" | "active" | "error";
type Profile = { display_name: string | null; email: string; status: "pending" | "active" | "suspended" };
type PortalData = {
  familyId: string;
  children: { id: string; first_name: string; last_initial: string | null }[];
  classes: { id: string; title: string; description: string | null; meeting_time: string | null }[];
  assignments: { id: string; title: string; instructions: string | null; due_at: string | null; class_id: string }[];
  posts: { id: string; title: string; body: string; published_at: string | null; image_storage_path: string | null; audience: string }[];
  events: { id: string; title: string; description: string | null; starts_at: string; ends_at: string | null; location: string | null; class_id: string | null }[];
  documents: { id: string; title: string; kind: string; signature_status: string | null; storage_path: string | null }[];
  compliance: ComplianceItem[];
  roles: string[];
};

/**
 * PostgREST returns the joined requirement nested inside each row; the UI wants
 * the pair side by side. Rows whose requirement failed to embed are dropped
 * rather than rendered half-populated.
 */
function toComplianceItems(rows: unknown): ComplianceItem[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry) => {
    const row = entry as FamilyRequirement & { requirements?: Requirement };
    if (!row?.requirements) return [];
    const { requirements, ...rest } = row;
    return [{ row: rest as FamilyRequirement, requirement: requirements }];
  });
}

export default function PortalGate() {
  const [state, setState] = useState<PortalState>(() => isSupabaseConfigured() ? "loading" : "error");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [portal, setPortal] = useState<PortalData | null>(null);
  const [postImages, setPostImages] = useState<Record<string, string>>({});
  const [openChildId, setOpenChildId] = useState<string | null>(null);
  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) { setState("signed-out"); return; }
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.data && aal.data.nextLevel === "aal2" && aal.data.nextLevel !== aal.data.currentLevel) { setState("mfa-challenge"); return; }
    const result = await supabase.from("profiles").select("display_name,email,status").eq("id", data.user.id).single();
    if (result.error || !result.data) { setState("error"); return; }
    setProfile(result.data as Profile);
    if (result.data.status !== "active") { setState("pending"); return; }
    const membership = await supabase.from("family_members").select("family_id").eq("user_id", data.user.id);
    if (membership.error) { setState("error"); return; }
    const familyIds = (membership.data ?? []).map((row) => row.family_id);
    const safeFamilyIds = familyIds.length ? familyIds : ["00000000-0000-0000-0000-000000000000"];

    const childrenResult = await supabase.from("children").select("id,first_name,last_initial").in("family_id", safeFamilyIds).order("first_name");
    if (childrenResult.error) { setState("error"); return; }
    const childIds = (childrenResult.data ?? []).map((row) => row.id);
    const safeChildIds = childIds.length ? childIds : ["00000000-0000-0000-0000-000000000000"];

    const enrollmentResult = await supabase.from("enrollments").select("class_id").in("child_id", safeChildIds).eq("status", "active");
    const classIds = [...new Set((enrollmentResult.data ?? []).map((row) => row.class_id))];
    const safeClassIds = classIds.length ? classIds : ["00000000-0000-0000-0000-000000000000"];

    const [classes, assignments, posts, events, documents, roles] = await Promise.all([
      supabase.from("classes").select("id,title,description,meeting_time").in("id", safeClassIds).order("title"),
      supabase.from("assignments").select("id,title,instructions,due_at,class_id").not("published_at", "is", null).in("class_id", safeClassIds).order("due_at", { ascending: true }).limit(10),
      supabase.from("posts").select("id,title,body,published_at,image_storage_path,audience").order("published_at", { ascending: false }).limit(6),
      supabase.from("events").select("id,title,description,starts_at,ends_at,location,class_id").gte("starts_at", new Date().toISOString()).order("starts_at").limit(10),
      supabase.from("documents").select("id,title,kind,signature_status,storage_path").or(`family_id.in.(${safeFamilyIds.join(",")}),class_id.in.(${safeClassIds.join(",")})`).order("created_at", { ascending: false }).limit(8),
      supabase.from("user_roles").select("role").eq("user_id", data.user.id),
    ]);

    // Required documents and dues for the current school year. !inner keeps this
    // to requirements that are active in the year flagged current, so a family
    // never sees last year's handbook sitting unsigned.
    const compliance = await supabase
      .from("family_requirements")
      .select("id,requirement_id,family_id,status,signed_document_id,signed_at,signing_url,provider_document_id,amount_due,amount_paid,paid_at,payment_method,payment_reference,note,requirements!inner(id,school_year_id,kind,title,description,active,sort_order,document_id,public_sign_url,amount_per_family,amount_per_child,payment_url,due_on,school_years!inner(is_current))")
      .in("family_id", safeFamilyIds)
      .eq("requirements.active", true)
      .eq("requirements.school_years.is_current", true);
    const children = childrenResult;
    const failed = [children, classes, assignments, posts, events, documents, roles].find((item) => item.error);
    if (failed?.error) { setState("error"); return; }
    setPortal({ familyId: safeFamilyIds[0] ?? "", children: children.data ?? [], classes: classes.data ?? [], assignments: assignments.data ?? [], posts: posts.data ?? [], events: events.data ?? [], documents: documents.data ?? [], compliance: toComplianceItems(compliance.data), roles: (roles.data ?? []).map((item) => item.role) } as PortalData);
    setState("active");
    const withImages = ((posts.data ?? []) as PortalData["posts"]).filter((post) => post.image_storage_path);
    const urls: Record<string, string> = {};
    await Promise.all(withImages.map(async (post) => { const url = await getSignedFileUrl(supabase, post.image_storage_path!); if (url) urls[post.id] = url; }));
    setPostImages(urls);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function signOut() { await getSupabaseBrowserClient()?.auth.signOut(); window.location.assign("/family-village"); }

  async function openDocument(id: string, storagePath: string | null) {
    setOpenDocumentId(id); setDocumentUrl(null);
    if (!storagePath) return;
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const url = await getSignedFileUrl(supabase, storagePath);
    setDocumentUrl(url);
  }

  if (state === "loading") return <main className="portal-state"><p className="eyebrow">Family Village</p><h1>Gathering your village…</h1></main>;
  if (state === "signed-out") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><p>Your Family Village session has ended.</p><a href="/family-village">Return to sign in →</a></main>;
  if (state === "mfa-challenge") return <MfaChallengeScreen onVerified={load} onCancel={signOut} />;
  if (state === "error") return <main className="portal-state"><p className="eyebrow">Family Village</p><h1>We could not open your village.</h1><p>No private information was shown. Please try signing in again or contact a Village administrator.</p><a href="/family-village">Return to sign in →</a></main>;
  if (state === "pending") return <main className="portal-state"><p className="eyebrow">Approval required</p><h1>Welcome to the doorway.</h1><p>Your identity has been verified, but a Village administrator must connect <b>{profile?.email}</b> to the correct household and roles before any family information appears.</p><button onClick={signOut}>Sign out</button></main>;

  const empty = (copy: string) => <p className="portal-empty">{copy}</p>;
  const openPost = portal?.posts.find((post) => post.id === openPostId);
  const openEvent = portal?.events.find((event) => event.id === openEventId);
  const openDocument_ = portal?.documents.find((document) => document.id === openDocumentId);

  // Requirement masters and signed copies are already shown in Paperwork & dues,
  // so keep them out of the shared-files list rather than listing them twice.
  const className = (id: string | null) => portal?.classes.find((row) => row.id === id)?.title ?? null;

  const complianceDocumentIds = new Set(
    (portal?.compliance ?? []).flatMap((item) => [item.requirement.document_id, item.row.signed_document_id].filter(Boolean) as string[]),
  );
  const otherDocuments = (portal?.documents ?? []).filter((document) => !complianceDocumentIds.has(document.id));

  return <main className="live-portal">
    <AppHeader current="home" roles={portal?.roles ?? []} title="Family Village" subtitle="Your household’s week, gathered in one place." />
    <ComplianceBanner items={portal?.compliance ?? []} />
    <div className="portal-grid">
      <section className="portal-module portal-module-wide"><p className="eyebrow">Your children</p><h2>The family table</h2>{portal?.children.length ? <div className="portal-people">{portal.children.map(child => <div key={child.id} className="person-card clickable" role="button" tabIndex={0} onClick={() => setOpenChildId(child.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenChildId(child.id); } }}><span>{child.first_name.slice(0,1)}</span><h3>{child.first_name}{child.last_initial ? ` ${child.last_initial}.` : ""}</h3></div>)}</div> : empty("Children will appear here after an administrator connects this account to your household.")}
        {portal && <AddChildForm familyId={portal.familyId} onAdded={load} />}
      </section>
      <section className="portal-module"><p className="eyebrow">Coming up</p><h2>Village calendar</h2>{portal?.events.length ? <ol className="portal-list clickable-list">{portal.events.map(event => <li key={event.id}><div role="button" tabIndex={0} onClick={() => setOpenEventId(event.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenEventId(event.id); } }} style={{ display: "contents" }}><time>{new Date(event.starts_at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time><div><b>{event.title}</b><span>{[className(event.class_id), event.location].filter(Boolean).join(" · ")}</span></div></div></li>)}</ol> : empty("No upcoming events have been published yet.")}</section>
      <section className="portal-module"><p className="eyebrow">From the co-op</p><h2>News & notices</h2>{portal?.posts.length ? <ol className="portal-list portal-news clickable-list">{portal.posts.map(post => <li key={post.id}><div role="button" tabIndex={0} onClick={() => setOpenPostId(post.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenPostId(post.id); } }} style={{ display: "contents" }}>{postImages[post.id] && <img src={postImages[post.id]} alt="" style={{ width: 64, height: 64, objectFit: "cover", flexShrink: 0 }} />}<div><b>{post.title}</b><span>{post.body.length > 130 ? `${post.body.slice(0,130)}…` : post.body}</span></div></div></li>)}</ol> : empty("News from the co-op will appear here when it is published.")}</section>
      <section className="portal-module"><p className="eyebrow">Learning</p><h2>Classes & assignments</h2>{portal?.assignments.length ? <ol className="portal-list">{portal.assignments.map(item => <li key={item.id}><time>{item.due_at ? new Date(item.due_at).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "Open"}</time><div><b>{item.title}</b><span>{[className(item.class_id), item.instructions].filter(Boolean).join(" · ")}</span></div></li>)}</ol> : empty(portal?.classes.length ? "No assignments are currently due." : "Classes will appear after enrollment is entered.")}</section>
      {/* Documents that aren't a requirement -- class handouts and anything an
          administrator has shared with this household. Signed copies are
          excluded because they already appear above, against their requirement. */}
      <section className="portal-module"><p className="eyebrow">Shared files</p><h2>Handouts &amp; other documents</h2>{otherDocuments.length ? <ol className="portal-list portal-docs clickable-list">{otherDocuments.map(document => <li key={document.id}><div role="button" tabIndex={0} onClick={() => openDocument(document.id, document.storage_path)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDocument(document.id, document.storage_path); } }} style={{ display: "contents" }}><div><b>{document.title}</b><span>{document.kind}</span></div></div></li>)}</ol> : empty("Handouts shared with your family or your children's classes will appear here.")}</section>
      <section className="portal-module portal-module-wide" id="paperwork"><p className="eyebrow">Family records</p><h2>Paperwork &amp; dues</h2>
        <CompliancePanel items={portal?.compliance ?? []} />
      </section>
    </div>
    {openChildId && <ChildDetail childId={openChildId} onClose={() => setOpenChildId(null)} />}
    {openPost && <DetailModal title={openPost.title} onClose={() => setOpenPostId(null)}>
      {postImages[openPost.id] && <img src={postImages[openPost.id]} alt="" style={{ width: "100%", maxHeight: 320, objectFit: "cover", marginBottom: 16 }} />}
      <p className="portal-empty" style={{ marginBottom: 8 }}>{openPost.published_at ? new Date(openPost.published_at).toLocaleDateString() : ""} · {openPost.audience}</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{openPost.body}</p>
    </DetailModal>}
    {openEvent && <DetailModal title={openEvent.title} onClose={() => setOpenEventId(null)}>
      <p className="portal-empty" style={{ marginBottom: 8 }}>{new Date(openEvent.starts_at).toLocaleString(undefined,{ month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })}{openEvent.ends_at ? ` – ${new Date(openEvent.ends_at).toLocaleTimeString(undefined,{ hour:"numeric", minute:"2-digit" })}` : ""}{openEvent.location ? ` · ${openEvent.location}` : ""}</p>
      {openEvent.description && <p style={{ whiteSpace: "pre-wrap" }}>{openEvent.description}</p>}
    </DetailModal>}
    {openDocument_ && <DetailModal title={openDocument_.title} onClose={() => { setOpenDocumentId(null); setDocumentUrl(null); }}>
      <p className="portal-empty" style={{ marginBottom: 16 }}>{openDocument_.kind}{openDocument_.signature_status ? ` · ${openDocument_.signature_status}` : ""}</p>
      {documentUrl ? <a href={documentUrl} target="_blank" rel="noreferrer" className="email-button" style={{ textDecoration: "none" }}>Open document ↗</a> : <p className="portal-empty">No file is attached to this record yet.</p>}
    </DetailModal>}
  </main>;
}

function AddChildForm({ familyId, onAdded }: { familyId: string; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firstName.trim() || !familyId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.from("children").insert({ family_id: familyId, first_name: firstName.trim() });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setFirstName(""); setAdding(false); setStatus(`Added ${firstName.trim()}.`);
    onAdded();
  }

  if (!adding) return <button className="add-child-trigger" onClick={() => setAdding(true)} style={{ marginTop: 18 }}>+ Add a child</button>;

  return <form onSubmit={submit} className="household-form" style={{ marginTop: 18 }}>
    <label>Add a child<input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="First name" disabled={busy} /></label>
    <button disabled={busy}>{busy ? "Adding…" : "Add child"}</button>
    <button type="button" onClick={() => { setAdding(false); setFirstName(""); }} style={{ background: "transparent", color: "var(--ink)", border: "1px solid rgba(7,43,73,.25)" }}>Cancel</button>
    <p className="admin-form-status" role="status">{status}</p>
  </form>;
}


