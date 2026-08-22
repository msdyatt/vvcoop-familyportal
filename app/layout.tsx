import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veritas Village | Central Texas Homeschool Co-op",
  description: "A shared place for Central Texas homeschool families to learn with intention and grow in community.",
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: { url: "/brand/favicon-180.png", sizes: "180x180", type: "image/png" },
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
  return <html lang="en">
    <head>
      {/* Playfair Display carries the high-contrast display serif the brand
          guide specifies for headings. Inter is the body face; the CSS stack
          falls through to the platform UI sans, which the guide allows. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font -- that rule targets the
          pages router, where a per-page <link> would load for one route only. This is the
          app-router root layout, so the stylesheet applies to every page. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@400;600;700&display=swap"
      />
    </head>
    <body>{children}</body>
  </html>;
}
