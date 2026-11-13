"use client";

import Image from "next/image";
import BrandLockup from "../brand-lockup";
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { useOutsideClick } from "../../lib/use-outside-click";
import PortalNav from "./portal-nav";
import DetailModal from "./detail-modal";
import AccountSettings from "./account-settings";
import Avatar from "./avatar";
import NotificationBell from "./notification-bell";
import UrgentBanner from "./urgent-banner";
import MessagesLink from "./messages/messages-link";
import { clearAvatarUrlCache, getSignedFileUrl } from "../../lib/storage";
import { disablePush } from "../../lib/push";
import AppTabBar from "./app-tab-bar";
import NativeSessionReporter from "./native-session-reporter";
import { TOUR_VERSION, isReturning } from "../../lib/onboarding";
import OnboardingTour from "./onboarding-tour";
import { nativeFrame } from "../../lib/native-frame";
import { clearNavCache, readCachedTeaches, sectionOf, withTeaching, writeCachedTeaches, type PortalKey } from "../../lib/nav-prefs";
import { teachesThisYear } from "../../lib/teaching-access";


export default function AppHeader({ current, roles: held, title, subtitle }: { current: PortalKey; roles: string[]; title: string; subtitle?: string }) {
  // Teaching shows for anyone with a class this year, not by role alone (lib/teaching-access.ts). The last answer is
  // kept on the device so it is right from the first paint, then confirmed once the person is known.
  const [teaches, setTeaches] = useState(() => (typeof window === "undefined" ? false : readCachedTeaches()));
  const roles = withTeaching(held, teaches);
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
    void teachesThisYear(supabase, data.user.id).then((yes) => { setTeaches(yes); writeCachedTeaches(yes); });
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

  // In the iPhone app the frame draws this header natively (logo, title, bell, profile) in the section's colours, and this one is hidden.
  useEffect(() => { nativeFrame()?.post("title", { title, theme: sectionOf(current) }); }, [title, current]);

  async function signOut() {
    // Stop pushes to this device before the session goes away, so the next
    // person to use a shared phone or computer doesn't receive them.
    await disablePush().catch(() => {});
    clearAvatarUrlCache();
    clearNavCache();
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  return <>
    <UrgentBanner />
    <header className={`app-header${current === "admin" ? " app-header-admin" : ""}`}>
      <a href="/family-village/home" className="app-header-brand" aria-label="Veritas Village home">
        {/* The guide's own navigation-bar example uses the primary horizontal
            lockup, and pairs the cream variant with dark fields -- which is
            Admin's navy band. Rendered at 150px wide, above its 120px minimum. */}
        {current === "admin"
          ? <Image className="app-header-lockup on-dark" src="/brand/lockup-horizontal-cream.png" alt="Veritas Village" width={900} height={310} priority />
          : <BrandLockup className="app-header-lockup" priority />}
        {/* In the apps the header takes the colour of the screen, so Admin needs the navy lockup there too. */}
        {current === "admin" && <Image className="app-header-lockup on-light" src="/brand/lockup-horizontal-navy.png" alt="" aria-hidden="true" width={900} height={310} />}
      </a>
      <div className="app-header-title">{current === "admin" && <span className="admin-chip app-header-admin-chip">Admin</span>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      <div className="app-header-actions">
        <PortalNav roles={roles} />
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
    <NativeSessionReporter />
    <AppTabBar current={current} roles={roles} onOpenAccount={() => setAccountOpen(true)} onTour={() => setTourOpen(true)} onSignOut={signOut} />
    {tourOpen && <OnboardingTour roles={roles} returning={returning} onFinish={finishTour} onOpenAccount={() => setAccountOpen(true)} />}
    {accountOpen && <DetailModal title="Account & security" onClose={() => setAccountOpen(false)}>
      <AccountSettings email={email} onSignOut={signOut} onProfileUpdated={loadProfile} />
    </DetailModal>}
  </>;
}
