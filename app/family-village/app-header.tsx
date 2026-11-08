"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { useOutsideClick } from "../../lib/use-outside-click";
import PortalNav from "./portal-nav";
import DetailModal from "./detail-modal";
import AccountSettings from "./account-settings";
import Avatar from "./avatar";
import NotificationBell from "./notification-bell";
import MessagesLink from "./messages/messages-link";
import { clearAvatarUrlCache, getSignedFileUrl } from "../../lib/storage";
import { disablePush } from "../../lib/push";
import AppTabBar from "./app-tab-bar";
import { TOUR_VERSION, isReturning } from "../../lib/onboarding";
import OnboardingTour from "./onboarding-tour";

type PortalKey = "home" | "admin" | "teacher";

export default function AppHeader({ current, roles, title, subtitle }: { current: PortalKey; roles: string[]; title: string; subtitle?: string }) {
  const [email, setEmail] = useState("");
  const [initial, setInitial] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [returning, setReturning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  async function loadProfile() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    const { data: profile } = await supabase.from("profiles").select("display_name,email,avatar_path,onboarding_version,created_at").eq("id", data.user.id).single();
    const resolvedEmail = profile?.email || data.user.email || "";
    const name = profile?.display_name || resolvedEmail;
    setEmail(resolvedEmail);
    setInitial(name.slice(0, 1).toUpperCase());
    setAvatarUrl(profile?.avatar_path ? await getSignedFileUrl(supabase, profile.avatar_path) : null);
    // First run (or a new version of the tour): show it once.
    if (profile && (profile.onboarding_version ?? 0) < TOUR_VERSION) {
      setReturning(isReturning(profile.created_at));
      setTourOpen(true);
    }
  }

  async function finishTour() {
    setTourOpen(false);
    await getSupabaseBrowserClient()?.rpc("complete_onboarding", { p_version: TOUR_VERSION });
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { loadProfile(); }, []);

  useOutsideClick(menuRef, () => setMenuOpen(false));

  async function signOut() {
    // Stop pushes to this device before the session goes away, so the next
    // person to use a shared phone or computer doesn't receive them.
    await disablePush().catch(() => {});
    clearAvatarUrlCache();
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  return <>
    <header className="app-header">
      <a href="/family-village/home" className="app-header-brand" aria-label="Veritas Village home">
        {/* The guide's own navigation-bar example uses the primary horizontal
            lockup, and pairs the cream variant with dark fields -- which is
            Admin's navy band. Rendered at 150px wide, above its 120px minimum. */}
        <Image
          className="app-header-lockup"
          src={current === "admin" ? "/brand/lockup-horizontal-cream.png" : "/brand/lockup-horizontal-navy.png"}
          alt="Veritas Village"
          width={900}
          height={310}
          priority
        />
      </a>
      <div className="app-header-title"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      <div className="app-header-actions">
        <PortalNav current={current} roles={roles} />
        <a className="messages-link" href="/family-village/photos">Photos</a>
        <MessagesLink />
        <NotificationBell />
        <div className="account-menu" ref={menuRef}>
          <button type="button" className="account-avatar-button" onClick={() => setMenuOpen((value) => !value)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Account menu">
            <Avatar url={avatarUrl} label={initial || "…"} size="sm" />
            <span className="account-avatar-detail" aria-hidden="true" />
          </button>
          {menuOpen && <div className="account-dropdown" role="menu">
            <button role="menuitem" onClick={() => { setAccountOpen(true); setMenuOpen(false); }}>Account &amp; security</button>
            <button role="menuitem" onClick={() => { setTourOpen(true); setMenuOpen(false); }}>Take the tour</button>
            <button role="menuitem" onClick={signOut}>Sign out</button>
          </div>}
        </div>
      </div>
    </header>
    <AppTabBar current={current} roles={roles} onOpenAccount={() => setAccountOpen(true)} onTour={() => setTourOpen(true)} onSignOut={signOut} />
    {tourOpen && <OnboardingTour roles={roles} returning={returning} onFinish={finishTour} onOpenAccount={() => setAccountOpen(true)} />}
    {accountOpen && <DetailModal title="Account & security" onClose={() => setAccountOpen(false)}>
      <AccountSettings email={email} onSignOut={signOut} onProfileUpdated={loadProfile} />
    </DetailModal>}
  </>;
}
