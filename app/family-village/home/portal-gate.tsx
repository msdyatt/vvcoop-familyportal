"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../../../lib/supabase";

type PortalState = "loading" | "signed-out" | "pending" | "active" | "error";
type Profile = { display_name: string | null; email: string; status: "pending" | "active" | "suspended" };

export default function PortalGate() {
  const [state, setState] = useState<PortalState>(() => isSupabaseConfigured() ? "loading" : "error");
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    supabase.auth.getUser().then(async ({ data, error }) => {
      if (error || !data.user) { setState("signed-out"); return; }
      const result = await supabase.from("profiles").select("display_name,email,status").eq("id", data.user.id).single();
      if (result.error || !result.data) { setState("error"); return; }
      setProfile(result.data as Profile);
      setState(result.data.status === "active" ? "active" : "pending");
    });
  }, []);

  async function signOut() {
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  if (state === "loading") return <main className="portal-state"><p className="eyebrow">Family Village</p><h1>Gathering your village…</h1></main>;
  if (state === "signed-out") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><p>Your Family Village session has ended.</p><a href="/family-village">Return to sign in →</a></main>;
  if (state === "error") return <main className="portal-state"><p className="eyebrow">Family Village setup</p><h1>The secure connection is not ready.</h1><p>No private information has been loaded. An administrator still needs to connect the Supabase project.</p><a href="/family-village">Return to sign in →</a></main>;
  if (state === "pending") return <main className="portal-state"><p className="eyebrow">Approval required</p><h1>Welcome to the doorway.</h1><p>Your identity has been verified, but a Village administrator must connect <b>{profile?.email}</b> to the correct household and roles before any family information appears.</p><button onClick={signOut}>Sign out</button></main>;

  return <main className="portal-state"><p className="eyebrow">Family Village</p><h1>Welcome{profile?.display_name ? `, ${profile.display_name}` : ""}.</h1><p>Your account is active. Family-specific records will populate here as the administrator creates households, children, classes, and enrollments.</p><div className="active-actions"><a href="/family-village/preview">Open the portal experience →</a><button onClick={signOut}>Sign out</button></div></main>;
}
