import Image from "next/image";

export const metadata = {
  title: "Terms & Conditions | Veritas Village",
};

export default function Terms() { return <>
  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- next/link's RSC prefetch errors in this vinext runtime; the rest of the site deliberately uses plain <a> for every route, this included */}
  <header className="site-header"><a href="/" className="mini-brand" aria-label="Veritas Village"><Image src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} priority/></a><nav aria-label="Main navigation"><a href="/">Home</a></nav><a className="header-link" href="https://family.veritasvillage.org/family-village">Family sign in</a></header>

  <main className="legal-page">
    <p className="eyebrow">Terms &amp; Conditions</p>
    <h1>Using the Family Village app.</h1>

    <div className="legal-draft-notice">
      <strong>This page is a working draft, not a finished legal document.</strong>
      <p>It was written to describe how the Family Village app is actually meant to be used today, in plain language, as a starting point. It has not been reviewed by an attorney and doesn&rsquo;t cover the co-op&rsquo;s own policies (enrollment, tuition, liability, code of conduct) — please have it reviewed and filled in before treating it as the co-op&rsquo;s real, binding terms.</p>
    </div>

    <p><em>Last updated: to be set once reviewed.</em></p>

    <h2>What this is</h2>
    <p>Family Village is a private, invitation-only app for Veritas Village co-op households, teachers, and administrators. It handles enrollment, class rosters, schedules, required paperwork, dues status, and communication between families and the teaching team. It is not open to the public, and access is by invitation from a co-op administrator.</p>

    <h2>Your account</h2>
    <ul>
      <li>Keep your password (or passkey) and any calendar subscribe link private — they grant access to your household&rsquo;s information.</li>
      <li>The information you enter about your household and children should be accurate, and kept up to date as it changes.</li>
      <li>An administrator can suspend or remove an account, most often at a family&rsquo;s own request when leaving the co-op, or if the information in this section is misused.</li>
    </ul>

    <h2>Content you post</h2>
    <p>Notes, photos, and files you add (a child&rsquo;s photo, a teacher&rsquo;s note, a class handout) should be things you have the right to share and that are appropriate for a family/school setting. Administrators can remove content that doesn&rsquo;t meet that bar.</p>

    <h2>Signed forms and dues</h2>
    <p>Forms signed through the app (via our e-signature provider, OpenSign) are treated as the household&rsquo;s real signature. Dues and payment status recorded in the app reflect what the co-op has been told was paid, through whatever payment method the co-op actually uses — the app itself does not process payments.</p>

    <h2>What we don&rsquo;t cover here</h2>
    <p><em>[Flag for legal review: this app&rsquo;s terms are about USING THE SOFTWARE. The co-op&rsquo;s actual policies — enrollment agreements, tuition and refund terms, liability waivers, code of conduct, what happens if a family withdraws mid-year — are separate documents the co-op already has (some are signed as compliance requirements inside the app). This page shouldn&rsquo;t try to restate those; it should link to them once the co-op decides where they live.]</em></p>

    <h2>Changes</h2>
    <p>These terms may be updated as the app changes. Continuing to use Family Village after a change means you accept the updated terms.</p>

    <h2>Questions</h2>
    <p>Questions about these terms can go to <a href="mailto:veritasvillagecoop@gmail.com">veritasvillagecoop@gmail.com</a>.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
