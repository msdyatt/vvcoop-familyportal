import Image from "next/image";

/**
 * The horizontal Veritas Village lockup in both colourways: navy for the light theme, cream for the dark one.
 * Both are in the page; CSS (theme.css) shows the one that suits the theme, so the swap needs no script and
 * cannot flash. The cream copy is decorative (the navy one carries the name) and loads only when it is shown.
 */
export default function BrandLockup({ className = "", priority = false, sizes, width = 900, height = 310 }: { className?: string; priority?: boolean; sizes?: string; width?: number; height?: number }) {
  return <>
    <Image className={`${className} logo-on-light`.trim()} src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={width} height={height} priority={priority} sizes={sizes} />
    <Image className={`${className} logo-on-dark`.trim()} src="/brand/lockup-horizontal-cream.png" alt="" aria-hidden="true" width={width} height={height} sizes={sizes} />
  </>;
}
