"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../../../lib/supabase";
import { getSignedFileUrl, getSignedFileUrls } from "../../../lib/storage";
import ChildDetail from "../child-detail";
import Avatar from "../avatar";
import DetailModal from "../detail-modal";
import AppHeader from "../app-header";
import RichText, { stripRichText } from "../../../lib/rich-text";
import MfaChallengeScreen from "../mfa-challenge";
import { ComplianceBanner, CompliancePanel, ComplianceItem } from "../compliance-panel";
import PostAttachments, { PostThumbnail, usePostAttachments } from "../post-attachments";
import { FamilyRequirement, Requirement, SchoolYear } from "../../../lib/compliance";
import { PersonalSubscribeLink } from "../subscribe-link";

type PortalState = "loading" | "signed-out" | "mfa-challenge" | "pending" | "active" | "error";
type Profile = { display_name: string | null; email: string; status: "pending" | "active" | "suspended" };
type PortalData = {
  familyId: string;
  children: { id: string; first_name: string; last_initial: string | null; avatar_path: string | null }[];
  enrollments: { child_id: string; class_id: string }[];
  classes: { id: string; title: string; description: string | null }[];
  posts: { id: string; title: string; body: string; published_at: string | null; audience: string }[];
  events: { id: string; title: string; description: string | null; starts_at: string; ends_at: string | null; location: string | null; class_id: string | null; audience: string; requires_prework: boolean; all_day: boolean }[];
  documents: { id: string; title: string; kind: string; signature_status: string | null; storage_path: string | null }[];
  compliance: ComplianceItem[];
  roles: string[];
  enrollmentPeriod: { title: string; closesAt: string } | null;
  completions: { event_id: string; child_id: string }[];
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
  const [openChildId, setOpenChildId] = useState<string | null>(null);
  const postAttachments = usePostAttachments((portal?.posts ?? []).map((post) => post.id));
  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [userId, setUserId] = useState<string | null>(null);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) { setState("signed-out"); return; }
    setUserId(data.user.id);
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

    const childrenResult = await supabase.from("children").select("id,first_name,last_initial,avatar_path").in("family_id", safeFamilyIds).order("first_name");
    if (childrenResult.error) { setState("error"); return; }
    const childIds = (childrenResult.data ?? []).map((row) => row.id);
    const safeChildIds = childIds.length ? childIds : ["00000000-0000-0000-0000-000000000000"];

    const enrollmentResult = await supabase.from("enrollments").select("child_id,class_id").in("child_id", safeChildIds).eq("status", "active");
    const classIds = [...new Set((enrollmentResult.data ?? []).map((row) => row.class_id))];
    const safeClassIds = classIds.length ? classIds : ["00000000-0000-0000-0000-000000000000"];

    const [classes, posts, events, documents, roles] = await Promise.all([
      supabase.from("classes").select("id,title,description").in("id", safeClassIds).order("title"),
      // Ask for family news explicitly. Leaning on RLS alone leaked staff news
      // here: it permits a teacher to read `teachers` posts, so anyone who is
      // both a parent and a teacher saw them on their family dashboard.
      supabase.from("posts").select("id,title,body,published_at,audience").in("audience", ["public", "families"]).not("published_at", "is", null).order("published_at", { ascending: false }).limit(6),
      supabase.from("events").select("id,title,description,starts_at,ends_at,location,class_id,audience,requires_prework,all_day").gte("starts_at", new Date().toISOString()).order("starts_at").limit(20),
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
    const failed = [children, classes, posts, events, documents, roles].find((item) => item.error);
    if (failed?.error) { setState("error"); return; }

    const preworkIds = (events.data ?? []).filter((event) => event.requires_prework).map((event) => event.id);
    const { data: completionRows } = preworkIds.length
      ? await supabase.from("event_completions").select("event_id,child_id").in("event_id", preworkIds).in("child_id", safeChildIds)
      : { data: [] };

    const nowIso = new Date().toISOString();
    const { data: periodRows } = await supabase.from("enrollment_periods")
      .select("title,closes_at").eq("active", true).lte("opens_at", nowIso).gte("closes_at", nowIso).limit(1);
    const period = (periodRows ?? [])[0];

    setPortal({
      familyId: safeFamilyIds[0] ?? "", children: children.data ?? [], enrollments: enrollmentResult.data ?? [], classes: classes.data ?? [], posts: posts.data ?? [],
      events: events.data ?? [], documents: documents.data ?? [], compliance: toComplianceItems(compliance.data),
      roles: (roles.data ?? []).map((item) => item.role),
      enrollmentPeriod: period ? { title: period.title, closesAt: period.closes_at } : null,
      completions: completionRows ?? [],
    } as PortalData);
    setState("active");

    const avatarPaths = (children.data ?? []).map((row) => row.avatar_path).filter((path): path is string => !!path);
    if (avatarPaths.length) setAvatarUrls(await getSignedFileUrls(supabase, avatarPaths));
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

  async function setEventCompletion(eventId: string, childIds: string[], done: boolean) {
    const supabase = getSupabaseBrowserClient(); if (!supabase || !childIds.length) return;
    const { data } = await supabase.auth.getUser(); if (!data.user) return;
    const result = done
      ? await supabase.from("event_completions").upsert(childIds.map((childId) => ({ event_id: eventId, child_id: childId, completed_by: data.user!.id })), { onConflict: "event_id,child_id" })
      : await supabase.from("event_completions").delete().eq("event_id", eventId).in("child_id", childIds);
    if (!result.error) await load();
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

  // Class dates belong to one class and are shown against it. Keeping them out
  // of the Village calendar stops a shoebox reminder for one elective sitting
  // between two co-op-wide dates every family needs to read.
  const coopEvents = (portal?.events ?? []).filter((event) => event.audience !== "class");
  const classDates = (portal?.events ?? []).filter((event) => event.audience === "class");

  const complianceDocumentIds = new Set(
    (portal?.compliance ?? []).flatMap((item) => [item.requirement.document_id, item.row.signed_document_id].filter(Boolean) as string[]),
  );
  const otherDocuments = (portal?.documents ?? []).filter((document) => !complianceDocumentIds.has(document.id));

  return <main className="live-portal">
    <AppHeader current="home" roles={portal?.roles ?? []} title="Family Village" subtitle="Your household’s week, gathered in one place." />
    <ComplianceBanner items={portal?.compliance ?? []} />
    {portal?.enrollmentPeriod && <aside className="compliance-banner" role="status">
      <span className="compliance-banner-count">✓</span>
      <div>
        <b>Enrollment is open</b>
        <span>{portal.enrollmentPeriod.title} closes {new Date(portal.enrollmentPeriod.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} — open a child below to choose classes.</span>
      </div>
      <a href="#my-children">Choose classes →</a>
    </aside>}
    <div className="portal-grid">
      <section id="my-children" className="portal-module portal-module-wide"><p className="eyebrow">Your children</p><h2>The family table</h2>{portal?.children.length ? <div className="portal-people">{portal.children.map(child => <div key={child.id} className="person-card clickable" role="button" tabIndex={0} onClick={() => setOpenChildId(child.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenChildId(child.id); } }}><Avatar url={child.avatar_path ? avatarUrls.get(child.avatar_path) ?? null : null} label={child.first_name} /><h3>{child.first_name}{child.last_initial ? ` ${child.last_initial}.` : ""}</h3>{portal.enrollmentPeriod && <small className="enroll-dot">Enroll</small>}</div>)}</div> : empty("Children will appear here after an administrator connects this account to your household.")}
        {portal && <AddChildForm familyId={portal.familyId} onAdded={load} />}
      </section>
      <section className="portal-module"><p className="eyebrow">Coming up</p><h2>Village calendar</h2>{coopEvents.length ? <ol className="portal-list clickable-list">{coopEvents.map(event => <li key={event.id}><div role="button" tabIndex={0} onClick={() => setOpenEventId(event.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenEventId(event.id); } }} style={{ display: "contents" }}><time>{new Date(event.starts_at).toLocaleDateString("en-US",{month:"short",day:"numeric", timeZone: event.all_day ? "UTC" : undefined})}</time><div><b>{event.title}</b><span>{[className(event.class_id), event.location].filter(Boolean).join(" · ")}</span></div></div></li>)}</ol> : empty("No co-op dates have been published yet.")}
        {userId && <div className="calendar-subscribe-row"><PersonalSubscribeLink userId={userId} /></div>}
      </section>
      <section className="portal-module"><p className="eyebrow">From the co-op</p><h2>News & notices</h2>{portal?.posts.length ? <ol className="portal-list portal-news clickable-list">{portal.posts.map(post => { const excerpt = stripRichText(post.body); return <li key={post.id}><div role="button" tabIndex={0} onClick={() => setOpenPostId(post.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenPostId(post.id); } }} style={{ display: "contents" }}><PostThumbnail attachments={postAttachments[post.id] ?? []} /><div><b>{post.title}</b><span>{excerpt.length > 130 ? `${excerpt.slice(0,130)}…` : excerpt}</span></div></div></li>; })}</ol> : empty("News from the co-op will appear here when it is published.")}</section>
      {/* Class dates, per class, with anything needing prep called out. This
          replaces the old assignments list -- homework is now a flag on a date
          rather than a separate row, so a parent reads one list instead of two. */}
      <section className="portal-module"><p className="eyebrow">Learning</p><h2>In your children&rsquo;s classes</h2>{classDates.length
        ? <ol className="portal-list class-event-list">{classDates.map(event => {
            const childIds = (portal?.enrollments ?? []).filter((entry) => entry.class_id === event.class_id).map((entry) => entry.child_id);
            const completedIds = new Set((portal?.completions ?? []).filter((entry) => entry.event_id === event.id).map((entry) => entry.child_id));
            const allDone = childIds.length > 0 && childIds.every((id) => completedIds.has(id));
            return <li key={event.id}>
              <button className="class-event-open" onClick={() => setOpenEventId(event.id)}><time>{new Date(event.starts_at).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</time><span><b>{event.title}</b><small>{[className(event.class_id), event.location].filter(Boolean).join(" · ")}</small></span></button>
              {event.requires_prework && <div className="event-completion-group">
                {childIds.map((childId) => { const child = portal?.children.find((row) => row.id === childId); const done = completedIds.has(childId); return <label key={childId} className={done ? "done" : ""}><input type="checkbox" checked={done} onChange={() => setEventCompletion(event.id, [childId], !done)} />{child?.first_name ?? "Student"} {done ? "ready" : "assignment"}</label>; })}
                {childIds.length > 1 && <button onClick={() => setEventCompletion(event.id, childIds, !allDone)}>{allDone ? "Clear all" : "Mark all ready"}</button>}
              </div>}
            </li>;
          })}</ol>
        : empty(portal?.classes.length ? "Nothing scheduled in your children's classes yet." : "Classes will appear after enrollment is entered.")}</section>
      {/* Documents that aren't a requirement -- class handouts and anything an
          administrator has shared with this household. Signed copies are
          excluded because they already appear above, against their requirement. */}
      <section className="portal-module"><p className="eyebrow">Shared files</p><h2>Handouts &amp; other documents</h2>{otherDocuments.length ? <ol className="portal-list portal-docs clickable-list">{otherDocuments.map(document => <li key={document.id}><div role="button" tabIndex={0} onClick={() => openDocument(document.id, document.storage_path)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDocument(document.id, document.storage_path); } }} style={{ display: "contents" }}><div><b>{document.title}</b><span>{document.kind}</span></div></div></li>)}</ol> : empty("Handouts shared with your family or your children's classes will appear here.")}</section>
      <section className="portal-module portal-module-wide" id="paperwork"><p className="eyebrow">Family records</p><h2>Paperwork &amp; dues</h2>
        {portal && <FamilyCompliance familyId={portal.familyId} />}
      </section>
    </div>

    <footer className="portal-footer">
      <a href="mailto:veritasvillagecoop@gmail.com?subject=Feedback%20on%20Family%20Village">Feedback</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms &amp; Conditions</a>
    </footer>

    {openChildId && <ChildDetail childId={openChildId} onClose={() => setOpenChildId(null)} />}
    {openPost && <DetailModal title={openPost.title} onClose={() => setOpenPostId(null)}>
      <p className="portal-empty compliance-note">{openPost.published_at ? new Date(openPost.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""} · {openPost.audience}</p>
      <RichText html={openPost.body} className="prose-body rich-text" />
      <PostAttachments attachments={postAttachments[openPost.id] ?? []} />
    </DetailModal>}
    {openEvent && <DetailModal title={openEvent.title} onClose={() => setOpenEventId(null)}>
      <p className="portal-empty" style={{ marginBottom: 8 }}>{openEvent.all_day
        ? new Date(openEvent.starts_at).toLocaleDateString("en-US",{ month:"short", day:"numeric", year:"numeric", timeZone:"UTC" })
        : `${new Date(openEvent.starts_at).toLocaleString("en-US",{ month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })}${openEvent.ends_at ? ` – ${new Date(openEvent.ends_at).toLocaleTimeString("en-US",{ hour:"numeric", minute:"2-digit" })}` : ""}`}{openEvent.location ? ` · ${openEvent.location}` : ""}</p>
      {openEvent.description && <p style={{ whiteSpace: "pre-wrap" }}>{openEvent.description}</p>}
    </DetailModal>}
    {openDocument_ && <DetailModal title={openDocument_.title} onClose={() => { setOpenDocumentId(null); setDocumentUrl(null); }}>
      <p className="portal-empty" style={{ marginBottom: 16 }}>{openDocument_.kind}{openDocument_.signature_status ? ` · ${openDocument_.signature_status}` : ""}</p>
      {documentUrl ? <a href={documentUrl} target="_blank" rel="noreferrer" className="email-button" style={{ textDecoration: "none" }}>Open document ↗</a> : <p className="portal-empty">No file is attached to this record yet.</p>}
    </DetailModal>}
  </main>;
}

/**
 * Paperwork & dues, with a year picker -- the rest of the dashboard is
 * always "this year," but a family may reasonably want to look back at a
 * past year's dues receipt or signed form. Self-contained (fetches its own
 * years and requirements) rather than folded into the big page-load effect,
 * since switching years shouldn't refetch everything else on the page.
 */
function FamilyCompliance({ familyId }: { familyId: string }) {
  const [years, setYears] = useState<SchoolYear[]>([]);
  const [yearId, setYearId] = useState("");
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadYears() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.from("school_years").select("id,label,starts_on,ends_on,is_current").order("starts_on", { ascending: false });
      if (cancelled) return;
      const rows = (data ?? []) as SchoolYear[];
      setYears(rows);
      const resolved = rows.find((year) => year.is_current)?.id || rows[0]?.id || "";
      setYearId((current) => current || resolved);
      // With no school year at all, the effect below (gated on `if (!yearId)
      // return`) never runs and never clears loading -- this panel would
      // otherwise show "Loading…" forever instead of settling into an empty
      // state.
      if (!resolved) setLoading(false);
    }
    loadYears();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!yearId) return;
    let cancelled = false;
    async function loadCompliance() {
      setLoading(true);
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase
        .from("family_requirements")
        .select("id,requirement_id,family_id,status,signed_document_id,signed_at,signing_url,provider_document_id,amount_due,amount_paid,paid_at,payment_method,payment_reference,note,requirements!inner(id,school_year_id,kind,title,description,active,sort_order,document_id,public_sign_url,amount_per_family,amount_per_child,payment_url,due_on)")
        .eq("family_id", familyId)
        .eq("requirements.active", true)
        .eq("requirements.school_year_id", yearId);
      if (cancelled) return;
      setItems(toComplianceItems(data));
      setLoading(false);
    }
    loadCompliance();
    return () => { cancelled = true; };
  }, [yearId, familyId]);

  return <>
    {years.length > 1 && <label className="compliance-year-picker"><span className="field-caption">School year</span>
      <select value={yearId} onChange={(event) => setYearId(event.target.value)}>
        {years.map((year) => <option key={year.id} value={year.id}>{year.label}{year.is_current ? " (current)" : ""}</option>)}
      </select>
    </label>}
    {loading ? <p className="portal-empty">Loading…</p> : <CompliancePanel items={items} />}
  </>;
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
