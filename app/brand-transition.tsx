"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function BrandTransition() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const hero = document.querySelector<HTMLElement>(".hero");
    if (!hero) return;

    const updateFromScroll = () => {
      setCompact(hero.getBoundingClientRect().bottom < window.innerHeight * 0.66);
    };

    updateFromScroll();

    const observer = new IntersectionObserver(
      ([entry]) => {
        setCompact(entry.intersectionRatio < 0.45);
      },
      { threshold: [0, 0.45, 1] },
    );

    observer.observe(hero);
    window.addEventListener("resize", updateFromScroll);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateFromScroll);
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
