import Image from "next/image";

export const metadata = {
  title: "Support | Veritas Village",
};

export default function Support() { return <>
  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- next/link's RSC prefetch errors in this vinext runtime; the rest of the site deliberately uses plain <a> for every route, this included */}
  <header className="site-header"><a href="/" className="mini-brand" aria-label="Veritas Village"><Image src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} priority/></a><nav aria-label="Main navigation"><a href="/">Home</a></nav><a className="header-link" href="https://family.veritasvillage.org/family-village">Family sign in</a></header>

  <main className="legal-page">
    <p className="eyebrow">Support</p>
    <h1>Help with Family Village.</h1>

    <p>Family Village is run by volunteers at Veritas Village, a Central Texas homeschool co-op. For anything below, or anything else, email <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a>. We usually reply within a couple of days.</p>

    <h2>Common questions</h2>

    <h3>I want to join, or I never got my invitation.</h3>
    <p>Family Village is invitation-only: a co-op administrator invites each household by email. If you are a member family and your invitation did not arrive or has expired, email us from the address you gave the co-op and we will send a new one.</p>

    <h3>I can&rsquo;t sign in.</h3>
    <p>Sign in with the email address your invitation was sent to, and the password you chose or a passkey. If you have lost access, email us and an administrator will help you back in.</p>

    <h3>Notifications aren&rsquo;t arriving.</h3>
    <p>Open the menu with your photo, then <strong>Account &amp; security</strong>, and look under <strong>Phone &amp; notifications</strong>. Turn notifications on for this device and press <strong>Send a test</strong>. On iPhone, notifications work once Family Village is added to your Home Screen or installed from the App Store. Also check that notifications are allowed for the app in your phone&rsquo;s Settings.</p>

    <h3>How do I add Family Village to my phone?</h3>
    <p>On iPhone, open the site in Safari, tap Share, then <strong>Add to Home Screen</strong>. On Android, open it in Chrome and choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</p>

    <h3>How do I report a message or a photo?</h3>
    <p>Open the message or the photo and choose <strong>Report</strong>. An administrator will look at it. You can also block someone from their conversation. If you need help urgently, email us.</p>

    <h3>How do I delete my account?</h3>
    <p>See <a href="/delete-account">how to delete your account</a>.</p>

    <h3>Questions about privacy?</h3>
    <p>Read our <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms</a>, or email us.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
