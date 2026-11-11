"use client";

import { useEffect, useState } from "react";

const navigation = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/programs", label: "Programs" },
  { href: "/contact", label: "Contact" },
];

export default function SiteHeader({ alwaysVisible = false }: { alwaysVisible?: boolean }) {
  const [revealed, setRevealed] = useState(alwaysVisible);

  useEffect(() => {
    const updateFromScroll = () => {
      setRevealed(alwaysVisible || window.scrollY > 48);
    };

    updateFromScroll();
    window.addEventListener("scroll", updateFromScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateFromScroll);
    };
  }, [alwaysVisible]);

  return (
    <header className={`site-header${revealed ? " is-revealed" : ""}`}>
      <nav aria-label="Main navigation">
        {navigation.map(({ href, label }) => <a key={href} href={href}>{label}</a>)}
      </nav>
      <a className="header-link" href="https://family.veritasvillage.org/family-village">
        Family sign in
      </a>
      <details>
        <summary>Menu</summary>
        <div>
          {navigation.map(({ href, label }) => <a key={href} href={href}>{label}</a>)}
          <a href="https://family.veritasvillage.org/family-village">Family sign in</a>
        </div>
      </details>
    </header>
  );
}
