"use client";

import { useEffect, useState } from "react";

export default function SiteHeader() {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const updateFromScroll = () => {
      setRevealed(window.scrollY > 48);
    };

    updateFromScroll();
    window.addEventListener("scroll", updateFromScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateFromScroll);
    };
  }, []);

  return (
    <header className={`site-header${revealed ? " is-revealed" : ""}`}>
      <nav aria-label="Main navigation">
        <a href="#welcome">Welcome</a>
        <a href="#families">Families</a>
        <a href="#rhythm">Our rhythm</a>
        <a href="#resources">Resources</a>
        <a href="#news">News</a>
      </nav>
      <a className="header-link" href="https://family.veritasvillage.org/family-village">
        Family sign in
      </a>
      <details>
        <summary>Menu</summary>
        <div>
          <a href="#welcome">Welcome</a>
          <a href="#families">Families</a>
          <a href="#rhythm">Our rhythm</a>
          <a href="#resources">Resources</a>
          <a href="#news">News</a>
          <a href="https://family.veritasvillage.org/family-village">Family sign in</a>
        </div>
      </details>
    </header>
  );
}
