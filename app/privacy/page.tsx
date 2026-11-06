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
      <p>It describes what Family Village actually collects and does today, in plain language, and was last brought up to date on 6 November 2026 to cover messaging, the photo library, notifications and the mobile apps. It has not been reviewed by an attorney. Because this app holds information about children, that review matters before this page is treated as the co-op&rsquo;s binding privacy policy. Items marked <em>[Flag for legal review]</em> need a decision or a lawyer&rsquo;s wording.</p>
    </div>

    <p><em>Last updated: 6 November 2026 (draft).</em></p>

    <h2>Who runs this</h2>
    <p>Family Village is run by Veritas Village, a Central Texas homeschool co-op and registered 501(c)(3) nonprofit. It is private and invitation-only, for the co-op&rsquo;s households, teachers, and administrators. It is available on the web and as an app for iPhone and Android, which is the same portal in a native wrapper.</p>

    <h2>What we collect</h2>
    <p>When a household is invited into Family Village, we collect what&rsquo;s needed to run the co-op:</p>
    <ul>
      <li><strong>Account information</strong> — email address, and a password or passkey to sign in.</li>
      <li><strong>Contact details</strong> — display name, phone number, and an emergency contact, if provided.</li>
      <li><strong>Household and children</strong> — a household name, and for each child: first and last name, birthdate or grade, and an optional photo.</li>
      <li><strong>Class and enrollment records</strong> — which classes and electives each child is enrolled in, and related schedule information.</li>
      <li><strong>Compliance records</strong> — signed forms (through our e-signature provider, OpenSign) and dues/payment status. We record that a payment was made and how, not full card or bank numbers.</li>
      <li><strong>Teacher notes</strong> — notes teachers write about a student&rsquo;s progress, visible to the people the note says it&rsquo;s for (family, the teaching team, or administrators).</li>
      <li><strong>Messages</strong> — the text and photos you send to other members, who they went to, and when. We also keep whether you have read a conversation, so we can show unread counts.</li>
      <li><strong>Photo library</strong> — photos you add, with any caption, date, class, and album you give them, and who added them. Photos are not tagged with children&rsquo;s names.</li>
      <li><strong>Notification devices</strong> — if you turn on notifications, a token that identifies that phone or browser so a notification can reach it.</li>
      <li><strong>Diagnostics and records of activity</strong> — an administrative log of actions like who sent a form, changed an enrollment, or reviewed a reported message; error reports that include the page address and browser details when something breaks; and page-visit counts from Cloudflare Web Analytics.</li>
    </ul>
    <p>Photos you add to messages or the photo library have the location and camera details stored inside them removed before they are uploaded.</p>

    <h2>Who can see it</h2>
    <p>Access follows role and relationship, not a blanket &ldquo;everyone can see everything&rdquo; model:</p>
    <ul>
      <li>A family can see and manage their own household, children, and records.</li>
      <li>A teacher can see the roster, notes, and records for the classes they teach — not other classes.</li>
      <li>An administrator can see what&rsquo;s needed to run the co-op: households, classes, enrollment, and compliance status.</li>
      <li>Curriculum files a teacher attaches to a class are visible to that teaching team only, not to enrolled families.</li>
      <li><strong>Messages</strong> are visible only to the people in that conversation. Administrators cannot browse private conversations. If a member reports a message, administrators can see that message and a few around it so they can judge it, and each time they do, it is recorded in the activity log.</li>
      <li><strong>Photo library</strong> photos are visible either to the whole co-op or to one class (its teachers, the families of enrolled children, and administrators), as chosen when the photo is added. A photo submitted by a parent is reviewed by a teacher of that class or an administrator before anyone else sees it. Anyone who can see a photo can report it, and administrators can remove it.</li>
    </ul>

    <h2>Who we share it with</h2>
    <p>We don&rsquo;t sell or rent family information, and there are no advertising or cross-site tracking tools in the app. A few outside services help run it, and see only what they need to do their job:</p>
    <ul>
      <li><strong>Supabase</strong> — hosts our database, sign-in, file storage (including photos), and live updates.</li>
      <li><strong>Cloudflare</strong> — hosts the web application and provides page-visit counts.</li>
      <li><strong>OpenSign</strong> — handles e-signatures for required forms.</li>
      <li><strong>Resend</strong> — sends invitation and reminder emails, so it sees the recipient&rsquo;s name and email address and the message.</li>
      <li><strong>Apple and Google (Firebase Cloud Messaging)</strong> — carry notifications to phones. They see the notification&rsquo;s title and text.</li>
      <li><strong>Google Fonts</strong> — the site&rsquo;s typefaces are loaded from Google, which means Google receives a visitor&rsquo;s IP address. <em>[We plan to host the fonts ourselves so this stops.]</em></li>
    </ul>

    <h2>Notifications</h2>
    <p>Notifications are optional and off until you turn them on in Account Settings. A message notification shows who sent it and the start of the message, so whether that appears on a locked screen depends on your phone&rsquo;s own notification settings. You can turn notifications off in Account Settings or in your phone or browser settings at any time, and you can mute any single conversation.</p>

    <h2>Calendar links</h2>
    <p>Account Settings can generate a private link so your class schedule and co-op events show up in your own calendar app (Apple Calendar, Google Calendar, etc.). That link is a long, hard-to-guess address rather than a login — anyone who has it can see what it shows, so it shouldn&rsquo;t be shared, and you can generate a new one at any time if you think it&rsquo;s been shared by mistake.</p>

    <h2>Children&rsquo;s information</h2>
    <p>Information about children is entered and controlled by their own parent or guardian, as part of managing the family&rsquo;s enrollment in the co-op — a child does not create their own account, send messages, or enter their own information. Photos in the shared library are added by teachers, administrators, or parents who confirm they have permission to share them; they are not tagged with children&rsquo;s names, and any family can report a photo and ask for it to be removed. <em>[Flag for legal review: confirm how this app&rsquo;s handling of children&rsquo;s data and photos should be described here, including whether COPPA or Texas law applies to a parent-run, invitation-only co-op tool like this one, and whether a photo release should be required.]</em></p>

    <h2>Your choices</h2>
    <ul>
      <li>You can see and change your own details in Account Settings.</li>
      <li>You can remove messages you sent and photos you added, mute a conversation, block a member, and report a message or photo.</li>
      <li>You can turn notifications on or off for each device.</li>
      <li>To ask for your personal information to be deleted, email <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a>. Today, &ldquo;Delete my account&rdquo; in the app removes your access but leaves household records in place for the co-op. <em>[Flag for legal review and a code change: the app should offer true deletion, and this section should state what is erased, what the co-op must keep, and how quickly we respond.]</em></li>
    </ul>

    <h2>How long we keep it</h2>
    <p>Messages and photos stay until the person who added them or an administrator removes them. Removing a message or photo erases its content and its files. <em>[Flag for legal review: the co-op should decide and state a real retention policy here — for example, how long records are kept after a family leaves, and when messages are deleted automatically.]</em></p>

    <h2>How we protect it</h2>
    <p>The app uses encrypted connections. Signing in is required, access is limited by role, and photos and files are kept in private storage that requires a signed-in account with permission to see them. Passkeys and two-factor sign-in are available. No system is perfectly secure, so please use a strong password or a passkey and keep your sign-in private.</p>

    <h2>Changes</h2>
    <p>We&rsquo;ll update this page when the app changes, and tell members in the app when a change matters.</p>

    <h2>Questions</h2>
    <p>Questions about this policy or your family&rsquo;s information can go to <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a>.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
