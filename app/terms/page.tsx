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
      <p>It describes how Family Village is meant to be used today, in plain language, and was last brought up to date on 6 November 2026 to cover messaging, the photo library and the mobile apps. It has not been reviewed by an attorney and doesn&rsquo;t cover the co-op&rsquo;s own policies (enrollment, tuition, liability, code of conduct) — please have it reviewed and filled in before treating it as the co-op&rsquo;s real, binding terms. Items marked <em>[Flag for legal review]</em> need a lawyer&rsquo;s wording.</p>
    </div>

    <p><em>Last updated: 6 November 2026 (draft).</em></p>

    <h2>What this is</h2>
    <p>Family Village is a private, invitation-only app for Veritas Village co-op households, teachers, and administrators, on the web and as an app for iPhone and Android. It handles enrollment, class rosters, schedules, required paperwork, dues status, messages between members, a shared photo library, and notifications. It is not open to the public, and access is by invitation from a co-op administrator.</p>

    <h2>Who can use it</h2>
    <p>Accounts are for adults: parents and guardians, teachers, and administrators. Children do not have accounts and do not use Family Village themselves.</p>

    <h2>Your account</h2>
    <ul>
      <li>Keep your password (or passkey) and any calendar subscribe link private — they grant access to your household&rsquo;s information.</li>
      <li>The information you enter about your household and children should be accurate, and kept up to date as it changes.</li>
      <li>An administrator can suspend or remove an account, most often at a family&rsquo;s own request when leaving the co-op, or if the account is misused or these terms are broken.</li>
    </ul>

    <h2>Messages and the photo library</h2>
    <p>Messaging and the photo library exist so the co-op can talk and share together. Please use them the way you would in person at co-op.</p>
    <ul>
      <li><strong>Be respectful.</strong> Don&rsquo;t harass, threaten, or demean anyone, and don&rsquo;t send hateful, sexual, violent, or illegal content, or spam.</li>
      <li><strong>Respect privacy.</strong> Don&rsquo;t share another family&rsquo;s private information, and don&rsquo;t post or send a photo of someone unless you have permission to share it with the people you chose. Be especially careful with other families&rsquo; children.</li>
      <li><strong>Keep photos in the co-op.</strong> Photos in the library are for the co-op&rsquo;s families. Don&rsquo;t post them publicly or elsewhere without the permission of the people in them.</li>
      <li><strong>You can report and block.</strong> Any member can report a message or photo, and can block another member so they can&rsquo;t message you. Administrators review reports and can remove content or suspend an account.</li>
      <li><strong>Who can see what.</strong> Messages are seen only by the people in the conversation; administrators don&rsquo;t browse them, but can see a reported message and the few around it. A photo is seen by the whole co-op or by one class, as chosen when it was added. Photos parents submit are reviewed before they appear.</li>
      <li><strong>Your content.</strong> You keep ownership of what you post. By posting, you let the co-op store it and show it to the people you chose within Family Village, for the purpose of running the co-op. <em>[Flag for legal review: the wording of this permission.]</em></li>
    </ul>

    <h2>Content you post elsewhere in the app</h2>
    <p>Notes, photos, and files you add (a child&rsquo;s photo, a teacher&rsquo;s note, a class handout) should be things you have the right to share and that are appropriate for a family and school setting. Administrators can remove content that doesn&rsquo;t meet that bar.</p>

    <h2>Notifications</h2>
    <p>Notifications are optional. You can turn them on or off for each device, and mute any conversation, whenever you like.</p>

    <h2>Signed forms and dues</h2>
    <p>Forms signed in the app are signed inside Family Village itself, by an adult who is signed in to their own account and has finished setting it up (confirmed invitation, name, and second sign-in step). Before signing you agree to sign electronically, and your typed or drawn signature is treated as the household&rsquo;s real signature on that form. Each signature is recorded with the time, your IP address and browser details, and the signed copy is kept by the co-op. You can ask the co-op for a paper copy or to arrange a paper signature instead. <em>[Flag for legal review: whether an electronic signature from one or both parents is enough for waivers and other forms that involve a minor.]</em></p>
    <p>Dues and payment status recorded in the app reflect what the co-op has been told was paid, through whatever payment method the co-op actually uses — the app itself does not process payments.</p>

    <h2>What we don&rsquo;t cover here</h2>
    <p>These terms are about using the software. The co-op&rsquo;s own policies — enrollment agreements, tuition and refund terms, liability waivers, code of conduct, what happens if a family withdraws mid-year — are separate documents the co-op already has, and some are signed as compliance requirements inside the app. <em>[Flag for legal review: this page should link to those documents rather than restate them, and should add the usual terms: disclaimers of warranty, limits of liability, how an account is ended, and governing law (Texas).]</em></p>

    <h2>Availability</h2>
    <p>We work to keep Family Village available and accurate, but it is run by volunteers and we can&rsquo;t promise it will always be uninterrupted or error-free.</p>

    <h2>Changes</h2>
    <p>These terms may be updated as the app changes. We&rsquo;ll tell members in the app when a change matters, and continuing to use Family Village after a change means you accept the updated terms.</p>

    <h2>Questions</h2>
    <p>Questions about these terms can go to <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a>.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
