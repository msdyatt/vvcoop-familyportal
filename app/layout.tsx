import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./platform.css";
import { PLATFORM_SCRIPT } from "../lib/platform";
import ErrorReporter from "./error-reporter";
import GlobalErrorBoundary from "./global-error-boundary";

export const viewport: Viewport = {
  themeColor: "#0b2a3d",
  // Lets the portal run edge to edge on notched phones once installed.
  viewportFit: "cover",
};

export const metadata: Metadata = {
  // Without this, a relative image URL in openGraph/twitter below resolves
  // against Next's dev-time fallback (http://localhost:3000) instead of the
  // real site -- which is exactly why the live Open Graph/Twitter card image
  // was pointing at localhost.
  metadataBase: new URL("https://family.veritasvillage.org"),
  title: "Veritas Village | Central Texas Homeschool Co-op",
  description: "A shared place for Central Texas homeschool families to learn with intention and grow in community.",
  manifest: "/manifest.webmanifest",
  // "black-translucent" makes the installed iPhone app's status bar fully
  // transparent, so the page draws under it. With "default", iOS paints its own
  // frosted-glass strip there, which showed as a haze above the header. The
  // page supplies a solid navy strip instead (see platform.css).
  appleWebApp: { capable: true, title: "Veritas Village", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: { url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
  openGraph: {
    title: "Veritas Village",
    description: "Learning in truth. Growing in community.",
    images: [{ url: "/brand/og-card.png", width: 1200, height: 630, alt: "Veritas Village" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Veritas Village",
    description: "Learning in truth. Growing in community.",
    images: ["/brand/og-card.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    <head>
      {/* Marks the page as iOS/Android and app/installed/browser before it paints, so platform styling never flashes in. */}
      <script dangerouslySetInnerHTML={{ __html: PLATFORM_SCRIPT }} />
      {/* Playfair Display carries the high-contrast display serif the brand
          guide specifies for headings. Inter is the body face; the CSS stack
          falls through to the platform UI sans, which the guide allows. Both
          are hosted here (see the @font-face rules at the top of globals.css),
          and the two Latin files are fetched early because every page uses them. */}
      <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="" />
      <link rel="preload" href="/fonts/playfair-display-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="" />
    </head>
    <body>
      <ErrorReporter />
      <GlobalErrorBoundary>{children}</GlobalErrorBoundary>
    </body>
  </html>;
}
