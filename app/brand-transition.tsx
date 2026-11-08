"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function BrandTransition() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const hero = document.querySelector<HTMLElement>(".hero");
    if (!hero) return;

    const updateFromScroll = () => {
      setCompact(hero.getBoundingClientRect().top < -48);
    };

    updateFromScroll();

    const observer = new IntersectionObserver(
      ([entry]) => {
        setCompact(entry.boundingClientRect.top < -48 || entry.intersectionRatio < 0.78);
      },
      { threshold: [0, 0.78, 1] },
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
