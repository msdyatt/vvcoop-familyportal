import CoopLogo from "./coop-logo";

/**
 * The co-op's horizontal lockup, following Light/Dark (the dark-ground version in the dark theme). Kept under its
 * old name so pages did not have to change; the drawing is CoopLogo's (app/coop-logo.tsx). The image props are
 * accepted and ignored: the size comes from the stylesheet and the co-op's own logo's shape.
 */
export default function BrandLockup({ className = "" }: { className?: string; priority?: boolean; sizes?: string; width?: number; height?: number }) {
  return <CoopLogo className={className} />;
}
