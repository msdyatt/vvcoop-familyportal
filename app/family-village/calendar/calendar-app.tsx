"use client";

import { usePortalAccess } from "../../../lib/use-portal-access";
import PageSkeleton from "../page-skeleton";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import AppHeader from "../app-header";
import CalendarView from "../calendar-view";
import MfaChallengeScreen from "../mfa-challenge";

export default function CalendarApp() {
  const { state: access, roles, recheck } = usePortalAccess("member");

  async function signOutToEntry() {
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  // The header and bar stay put while the page fills in; only the content area is a placeholder.
  if (access === "loading") return <main className="workspace-preview calendar-page"><AppHeader current="home" roles={roles} title={"Calendar"} subtitle={"Co-op dates and class dates."} /><PageSkeleton /></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><a href="/family-village">Return to sign in →</a></main>;

  return <main className="workspace-preview calendar-page">
    <AppHeader current="home" roles={roles} title="Calendar" subtitle="Co-op dates and class dates." />
    <CalendarView />
  </main>;
}
