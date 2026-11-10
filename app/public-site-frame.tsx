import type { ReactNode } from "react";
import SiteHeader from "./site-header";
import Link from "next/link";
import Image from "next/image";

export default function PublicSiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader alwaysVisible />
      <Link className="public-header-logo" href="/" aria-label="Veritas Village home">
        <Image src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} priority sizes="(max-width: 850px) 116px, 132px" />
      </Link>
      <main id="main-content" className="public-page">{children}</main>
      <footer className="public-footer">
        <span>Veritas Village</span>
        <span>Learning in truth. Growing in community.</span>
        <nav aria-label="Public website">
          <Link href="/">Home</Link>
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
