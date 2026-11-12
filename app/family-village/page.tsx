import BrandLockup from "../brand-lockup";
import SignInPanel from "./sign-in-panel";

export const metadata = {
  title: "Family Village | Veritas Village",
  description: "The private home for Veritas Village families and teachers.",
};

export default function FamilyVillageSignIn() {
  return <main className="portal-entry">
    <a className="portal-back" href="https://veritasvillage.org/">← Back to homepage</a>
    <section className="portal-entry-card">
      <div className="portal-entry-brand"><BrandLockup priority /></div>
      <p className="eyebrow">Invitation-only family portal</p>
      <h2 className="portal-entry-app-title">Sign in</h2>
      <h1>Everything your family<br/><em>needs for the week.</em></h1>
      <p className="portal-entry-copy">Family Village brings classes, messages with teachers, announcements, calendars, photographs, and signed documents together in one private place.</p>
      <SignInPanel />
      <a className="preview-link" href="/family-village/preview">Preview the family experience →</a>
      <p className="portal-legal-links"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a></p>
    </section>
  </main>;
}
