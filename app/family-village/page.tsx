import Image from "next/image";
import Link from "next/link";

export const metadata = {
  title: "Family Village | Veritas Village",
  description: "The private home for Veritas Village families and teachers.",
};

export default function FamilyVillageSignIn() {
  return <main className="portal-entry">
    <Link className="portal-back" href="/">← Return to Veritas Village</Link>
    <section className="portal-entry-card">
      <div className="portal-entry-brand"><Image src="/veritas-approved-lockup.png" alt="Veritas Village" width={1536} height={1024} priority /></div>
      <p className="eyebrow">Invitation-only family portal</p>
      <h1>Everything your family<br/><em>needs for the week.</em></h1>
      <p className="portal-entry-copy">Family Village brings classes, teacher notes, announcements, calendars, photographs, and signed documents together in one private place.</p>
      <div className="signin-stack" aria-label="Planned sign-in methods">
        <button disabled><span>G</span> Continue with Google</button>
        <button disabled><span>●</span> Continue with Apple</button>
        <button disabled><span>✉</span> Continue with email</button>
      </div>
      <p className="setup-note">Secure sign-in is being prepared. Access will be granted by invitation only.</p>
      <a className="preview-link" href="/family-village/preview">Preview the family experience →</a>
    </section>
    <aside className="portal-entry-aside">
      <p className="eyebrow">A private place for</p>
      <ol><li><b>Families</b><span>Children, classes, assignments, notes, forms, and photos.</span></li><li><b>Teachers</b><span>Class rosters, resources, assignments, and family-visible notes.</span></li><li><b>Administrators</b><span>Invitations, roles, enrollment, publishing, and document records.</span></li></ol>
      <p className="privacy-promise">No family receives access until an administrator connects the account to the correct household and children.</p>
    </aside>
  </main>;
}
