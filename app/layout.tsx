import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veritas Village | Central Texas Homeschool Co-op",
  description: "A shared place for Central Texas homeschool families to learn with intention and grow in community.",
  icons: { icon: "/veritas-mark.png" },
  openGraph: { title: "Veritas Village", description: "Learning in truth. Growing in community." },
  twitter: { card: "summary", title: "Veritas Village", description: "Learning in truth. Growing in community." }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
