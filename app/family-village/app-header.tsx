"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import PortalNav from "./portal-nav";
import DetailModal from "./detail-modal";
import AccountSettings from "./account-settings";

type PortalKey = "home" | "admin" | "teacher";

export default function AppHeader({ current, roles, title, subtitle }: { current: PortalKey; roles: string[]; title: string; subtitle?: string }) {
  const [email, setEmail] = useState("");
  const [initial, setInitial] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  async function loadProfile() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    const { data: profile } = await supabase.from("profiles").select("display_name,email").eq("id", data.user.id).single();
    const resolvedEmail = profile?.email || data.user.email || "";
    const name = profile?.display_name || resolvedEmail;
    setEmail(resolvedEmail);
    setInitial(name.slice(0, 1).toUpperCase());
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { loadProfile(); }, []);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function signOut() {
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  return <>
    <header className="app-header">
      <a href="/family-village/home" className="app-header-brand">
        <span className="app-header-logo">VV</span>
        <span className="app-header-wordmark">Veritas Village</span>
      </a>
      <div className="app-header-title"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      <div className="app-header-actions">
        <PortalNav current={current} roles={roles} />
        <div className="account-menu" ref={menuRef}>
          <button type="button" className="account-avatar" onClick={() => setMenuOpen((value) => !value)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Account menu">{initial || "…"}</button>
          {menuOpen && <div className="account-dropdown" role="menu">
            <button role="menuitem" onClick={() => { setAccountOpen(true); setMenuOpen(false); }}>Account &amp; security</button>
            <button role="menuitem" onClick={signOut}>Sign out</button>
          </div>}
        </div>
      </div>
    </header>
    {accountOpen && <DetailModal title="Account & security" onClose={() => setAccountOpen(false)}>
      <AccountSettings email={email} onSignOut={signOut} />
    </DetailModal>}
  </>;
}
