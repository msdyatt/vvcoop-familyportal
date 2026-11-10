import type { ReactNode } from "react";
import SiteHeader from "./site-header";

export default function PublicSiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader alwaysVisible />
      <main id="main-content" className="public-page">{children}</main>
      <footer className="public-footer">
        <span>Veritas Village</span>
        <span>Learning in truth. Growing in community.</span>
        <nav aria-label="Public website">
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/programs">Programs</a>
          <a href="/contact">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </>
  );
}
