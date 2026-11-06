import Image from "next/image";

export const metadata = {
  title: "Delete your account | Veritas Village",
};

export default function DeleteAccount() { return <>
  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- next/link's RSC prefetch errors in this vinext runtime; the rest of the site deliberately uses plain <a> for every route, this included */}
  <header className="site-header"><a href="/" className="mini-brand" aria-label="Veritas Village"><Image src="/brand/lockup-horizontal-navy.png" alt="Veritas Village" width={900} height={310} priority/></a><nav aria-label="Main navigation"><a href="/">Home</a></nav><a className="header-link" href="https://family.veritasvillage.org/family-village">Family sign in</a></header>

  <main className="legal-page">
    <p className="eyebrow">Delete your account</p>
    <h1>How to delete your Family Village account.</h1>

    <h2>In the app or on the website</h2>
    <ol>
      <li>Sign in to Family Village.</li>
      <li>Open the menu with your photo (top right), then <strong>Account &amp; security</strong>.</li>
      <li>Scroll to <strong>Delete account</strong>, choose <strong>Delete my account</strong>, type <strong>DELETE</strong> to confirm, and confirm.</li>
    </ol>
    <p>Your account is deleted straight away and you are signed out. We email you to confirm.</p>

    <h2>If you can&rsquo;t sign in</h2>
    <p>Email <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a> from the email address on your account and ask for your account to be deleted. An administrator will confirm it is you and delete it. <em>[Flag for legal review: confirm the response time we promise here, for example within 30 days.]</em></p>

    <h2>What is erased</h2>
    <ul>
      <li>Your sign-in, passkeys, and two-factor settings.</li>
      <li>Your name, phone number, emergency contact, and profile photo.</li>
      <li>Every message you sent, including photos you sent in messages.</li>
      <li>Your notification devices, notifications, blocks, and conversation memberships.</li>
      <li>Invitations and emails the co-op logged to your address, and your email address in the activity log.</li>
    </ul>

    <h2>What stays, without your name</h2>
    <ul>
      <li>Notes, news posts, and photos you added to the shared library, which belong to the co-op&rsquo;s records. Remove any photos you want gone before you delete your account.</li>
      <li>Records of forms you sent or signed for your household.</li>
      <li>Your household and children&rsquo;s records, if another adult is in the household. If you are the only adult, you can choose to delete the household too when you delete your account; if you don&rsquo;t, an administrator closes it out once the co-op&rsquo;s record-keeping needs are met, and you can ask for that sooner by email.</li>
    </ul>
    <p><em>[Flag for legal review: the co-op should confirm which records it must keep, and for how long.]</em></p>

    <p>More in our <a href="/privacy">Privacy Policy</a>.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
