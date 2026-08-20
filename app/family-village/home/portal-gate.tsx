"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../../../lib/supabase";

type PortalState = "loading" | "signed-out" | "pending" | "active" | "error";
type Profile = { display_name: string | null; email: string; status: "pending" | "active" | "suspended" };
type PortalData = {
  children: { id: string; first_name: string; last_initial: string | null }[];
  classes: { id: string; title: string; description: string | null; meeting_time: string | null }[];
  assignments: { id: string; title: string; due_at: string | null; class_id: string }[];
  posts: { id: string; title: string; body: string; published_at: string | null }[];
  events: { id: string; title: string; starts_at: string; location: string | null }[];
  documents: { id: string; title: string; kind: string; signature_status: string | null }[];
  roles: string[];
};

export default function PortalGate() {
  const [state, setState] = useState<PortalState>(() => isSupabaseConfigured() ? "loading" : "error");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [portal, setPortal] = useState<PortalData | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    supabase.auth.getUser().then(async ({ data, error }) => {
      if (error || !data.user) { setState("signed-out"); return; }
      const result = await supabase.from("profiles").select("display_name,email,status").eq("id", data.user.id).single();
      if (result.error || !result.data) { setState("error"); return; }
      setProfile(result.data as Profile);
      if (result.data.status !== "active") { setState("pending"); return; }
      const [children, classes, assignments, posts, events, documents, roles] = await Promise.all([
        supabase.from("children").select("id,first_name,last_initial").order("first_name"),
        supabase.from("classes").select("id,title,description,meeting_time").order("title"),
        supabase.from("assignments").select("id,title,due_at,class_id").order("due_at", { ascending: true }).limit(8),
        supabase.from("posts").select("id,title,body,published_at").order("published_at", { ascending: false }).limit(6),
        supabase.from("events").select("id,title,starts_at,location").gte("starts_at", new Date().toISOString()).order("starts_at").limit(8),
        supabase.from("documents").select("id,title,kind,signature_status").order("created_at", { ascending: false }).limit(8),
        supabase.from("user_roles").select("role"),
      ]);
      const failed = [children, classes, assignments, posts, events, documents, roles].find((item) => item.error);
      if (failed?.error) { setState("error"); return; }
      setPortal({ children: children.data ?? [], classes: classes.data ?? [], assignments: assignments.data ?? [], posts: posts.data ?? [], events: events.data ?? [], documents: documents.data ?? [], roles: (roles.data ?? []).map((item) => item.role) } as PortalData);
      setState("active");
    });
  }, []);

  async function signOut() { await getSupabaseBrowserClient()?.auth.signOut(); window.location.assign("/family-village"); }

  if (state === "loading") return <main className="portal-state"><p className="eyebrow">Family Village</p><h1>Gathering your village…</h1></main>;
  if (state === "signed-out") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><p>Your Family Village session has ended.</p><a href="/family-village">Return to sign in →</a></main>;
  if (state === "error") return <main className="portal-state"><p className="eyebrow">Family Village</p><h1>We could not open your village.</h1><p>No private information was shown. Please try signing in again or contact a Village administrator.</p><a href="/family-village">Return to sign in →</a></main>;
  if (state === "pending") return <main className="portal-state"><p className="eyebrow">Approval required</p><h1>Welcome to the doorway.</h1><p>Your identity has been verified, but a Village administrator must connect <b>{profile?.email}</b> to the correct household and roles before any family information appears.</p><button onClick={signOut}>Sign out</button></main>;

  const empty = (copy: string) => <p className="portal-empty">{copy}</p>;
  return <main className="live-portal">
    <header className="live-portal-head"><div><p className="eyebrow">Family Village · Private</p><h1>Welcome{profile?.display_name ? `, ${profile.display_name}` : ""}.</h1><p>Your household’s week, gathered in one place.</p></div><button onClick={signOut}>Sign out</button></header>
    <section className="portal-family-strip"><div><span>Children</span><strong>{portal?.children.length ?? 0}</strong></div><div><span>Classes</span><strong>{portal?.classes.length ?? 0}</strong></div><div><span>Upcoming work</span><strong>{portal?.assignments.length ?? 0}</strong></div></section>
    <div className="portal-grid">
      <section className="portal-module portal-module-wide"><p className="eyebrow">Your children</p><h2>The family table</h2>{portal?.children.length ? <div className="portal-people">{portal.children.map(child => <article key={child.id}><span>{child.first_name.slice(0,1)}</span><h3>{child.first_name}{child.last_initial ? ` ${child.last_initial}.` : ""}</h3></article>)}</div> : empty("Children will appear here after an administrator connects this account to your household.")}</section>
      <section className="portal-module"><p className="eyebrow">Coming up</p><h2>Village calendar</h2>{portal?.events.length ? <ol className="portal-list">{portal.events.map(event => <li key={event.id}><time>{new Date(event.starts_at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time><div><b>{event.title}</b>{event.location && <span>{event.location}</span>}</div></li>)}</ol> : empty("No upcoming events have been published yet.")}</section>
      <section className="portal-module"><p className="eyebrow">From the co-op</p><h2>News & notices</h2>{portal?.posts.length ? <ol className="portal-list portal-news">{portal.posts.map(post => <li key={post.id}><div><b>{post.title}</b><span>{post.body.length > 130 ? `${post.body.slice(0,130)}…` : post.body}</span></div></li>)}</ol> : empty("News from the co-op will appear here when it is published.")}</section>
      <section className="portal-module"><p className="eyebrow">Learning</p><h2>Classes & assignments</h2>{portal?.assignments.length ? <ol className="portal-list">{portal.assignments.map(item => <li key={item.id}><time>{item.due_at ? new Date(item.due_at).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "Open"}</time><div><b>{item.title}</b></div></li>)}</ol> : empty(portal?.classes.length ? "No assignments are currently due." : "Classes will appear after enrollment is entered.")}</section>
      <section className="portal-module"><p className="eyebrow">Family records</p><h2>Forms & documents</h2>{portal?.documents.length ? <ol className="portal-list portal-docs">{portal.documents.map(document => <li key={document.id}><div><b>{document.title}</b><span>{document.kind}{document.signature_status ? ` · ${document.signature_status}` : ""}</span></div></li>)}</ol> : empty("Signed forms and family documents will be available here once added.")}</section>
    </div>
    {portal?.roles.some(role => role === "teacher" || role === "admin") && <nav className="portal-role-links" aria-label="Staff workspaces">{portal.roles.includes("teacher") && <a href="/family-village/teacher">Teacher workspace →</a>}{portal.roles.includes("admin") && <a href="/family-village/admin">Administrator workspace →</a>}</nav>}
  </main>;
}
