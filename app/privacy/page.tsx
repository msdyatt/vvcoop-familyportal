import Image from "next/image";

export const metadata = {
  title: "Privacy Policy | Veritas Village",
};

export default function PrivacyPolicy() { return <>
  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- next/link's RSC prefetch errors in this vinext runtime; the rest of the site deliberately uses plain <a> for every route, this included */}
  <header className="site-header"><a href="/" className="mini-brand" aria-label="Veritas Village"><Image src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} priority/></a><nav aria-label="Main navigation"><a href="/">Home</a></nav><a className="header-link" href="https://family.veritasvillage.org/family-village">Family sign in</a></header>

  <main className="legal-page">
    <p className="eyebrow">Privacy Policy</p>
    <h1>How we handle your family&rsquo;s information.</h1>

    <div className="legal-draft-notice">
      <strong>This page is a working draft, not a finished legal document.</strong>
      <p>It was written to describe what the Family Village app actually collects and does today, in plain language, as a starting point. It has not been reviewed by an attorney. Because this app holds information about children, that review matters before this page is treated as the co-op&rsquo;s real, binding privacy policy — please have it checked before relying on it.</p>
    </div>

    <p><em>Last updated: to be set once reviewed.</em></p>

    <h2>What we collect</h2>
    <p>When a household is invited into Family Village, we collect what&rsquo;s needed to run the co-op:</p>
    <ul>
      <li><strong>Account information</strong> — email address, and a password or passkey to sign in.</li>
      <li><strong>Contact details</strong> — display name, phone number, and an emergency contact, if provided.</li>
      <li><strong>Household and children</strong> — a household name, and for each child: first and last name, birthdate or grade, and an optional photo.</li>
      <li><strong>Class and enrollment records</strong> — which classes and electives each child is enrolled in, and related schedule information.</li>
      <li><strong>Compliance records</strong> — signed forms (through our e-signature provider, OpenSign) and dues/payment status. We record that a payment was made and how, not full card or bank numbers.</li>
      <li><strong>Notes and communication</strong> — notes teachers write about a student&rsquo;s progress, visible to the people the note says it&rsquo;s for (family, the teaching team, or administrators).</li>
      <li><strong>Usage records</strong> — an administrative log of actions like who sent a form or changed an enrollment, kept for the co-op&rsquo;s own record-keeping.</li>
    </ul>

    <h2>Who can see it</h2>
    <p>Access follows role and relationship, not a blanket &ldquo;everyone can see everything&rdquo; model:</p>
    <ul>
      <li>A family can see and manage their own household, children, and records.</li>
      <li>A teacher can see the roster, notes, and records for the classes they teach — not other classes.</li>
      <li>An administrator can see what&rsquo;s needed to run the co-op: households, classes, enrollment, and compliance status.</li>
      <li>Curriculum files a teacher attaches to a class are visible to that teaching team only, not to enrolled families.</li>
    </ul>

    <h2>Who we share it with</h2>
    <p>We don&rsquo;t sell or rent family information. A few outside services help run the app, and see only what they need to do their job:</p>
    <ul>
      <li><strong>Supabase</strong> — hosts our database, authentication, and file storage.</li>
      <li><strong>Cloudflare</strong> — hosts the web application itself.</li>
      <li><strong>OpenSign</strong> — handles e-signatures for required forms.</li>
    </ul>

    <h2>Calendar links</h2>
    <p>Account Settings can generate a private link so your class schedule and co-op events show up in your own calendar app (Apple Calendar, Google Calendar, etc.). That link is a long, hard-to-guess address rather than a login — anyone who has it can see what it shows, so it shouldn&rsquo;t be shared, and you can generate a new one at any time if you think it&rsquo;s been shared by mistake.</p>

    <h2>Children&rsquo;s information</h2>
    <p>Information about children is entered and controlled by their own parent or guardian, as part of managing the family&rsquo;s enrollment in the co-op — a child does not create their own account or enter their own information. <em>[Flag for legal review: confirm how this app&rsquo;s handling of children&rsquo;s data should be described here, including whether COPPA or a similar framework applies to a parent-run, invitation-only co-op tool like this one.]</em></p>

    <h2>How long we keep it</h2>
    <p><em>[Flag for legal review: the co-op should decide and state a real retention policy here — for example, how long records are kept after a family leaves, and how a family can ask for their data to be deleted.]</em></p>

    <h2>Questions</h2>
    <p>Questions about this policy or your family&rsquo;s information can go to <a href="mailto:veritasvillagecoop@gmail.com">veritasvillagecoop@gmail.com</a>.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
