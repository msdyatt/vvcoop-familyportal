import Image from "next/image";
import SignInPanel from "./sign-in-panel";

export const metadata = {
  title: "Family Village | Veritas Village",
  description: "The private home for Veritas Village families and teachers.",
};

export default function FamilyVillageSignIn() {
  return <main className="portal-entry">
    <a className="portal-back" href="https://veritasvillage.org/">← Back to homepage</a>
    <section className="portal-entry-card">
      <div className="portal-entry-brand"><Image src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} priority /></div>
      <p className="eyebrow">Invitation-only family portal</p>
      <h1>Everything your family<br/><em>needs for the week.</em></h1>
      <p className="portal-entry-copy">Family Village brings classes, teacher notes, announcements, calendars, photographs, and signed documents together in one private place.</p>
      <SignInPanel />
      <a className="preview-link" href="/family-village/preview">Preview the family experience →</a>
    </section>
  </main>;
}
