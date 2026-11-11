"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function BrandTransition() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const updateFromScroll = () => {
      setCompact(window.scrollY > 48);
    };

    updateFromScroll();
    window.addEventListener("scroll", updateFromScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateFromScroll);
    };
  }, []);

  return (
    <a
      href="#top"
      className={`brand-transition${compact ? " is-compact" : ""}`}
      aria-label="Veritas Village"
    >
      <Image
        src="/brand/lockup-horizontal-navy.png"
        alt="Veritas Village"
        width={900}
        height={310}
        priority
        sizes="(max-width: 520px) 54vw, 360px"
      />
    </a>
  );
}
