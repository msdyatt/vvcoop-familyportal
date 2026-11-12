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
      <p>It describes what Family Village actually collects and does today, in plain language, and was last brought up to date on 7 November 2026 to cover online dues payments and expense records, on top of messaging, the photo library, notifications and the mobile apps. It has not been reviewed by an attorney. Because this app holds information about children, that review matters before this page is treated as the co-op&rsquo;s binding privacy policy. Items marked <em>[Flag for legal review]</em> need a decision or a lawyer&rsquo;s wording.</p>
    </div>

    <p><em>Last updated: 7 November 2026 (draft).</em></p>

    <h2>Who runs this</h2>
    <p>Family Village is run by Veritas Village, a Central Texas homeschool co-op and registered 501(c)(3) nonprofit. It is private and invitation-only, for the co-op&rsquo;s households, teachers, and administrators. It is available on the web and as an app for iPhone and Android, which is the same portal in a native wrapper.</p>

    <h2>What we collect</h2>
    <p>When a household is invited into Family Village, we collect what&rsquo;s needed to run the co-op:</p>
    <ul>
      <li><strong>Account information</strong> — email address, and a password or passkey to sign in.</li>
      <li><strong>Contact details</strong> — display name, phone number, and an emergency contact, if provided.</li>
      <li><strong>Household and children</strong> — a household name, and for each child: first and last name, birthdate or grade, and an optional photo.</li>
      <li><strong>Class and enrollment records</strong> — which classes and electives each child is enrolled in, and related schedule information.</li>
      <li><strong>Compliance records</strong> — signed forms (signed inside Family Village, see Electronic signatures below) and dues and payments (see Dues payments below). We never receive or store full card numbers, security codes or full bank account numbers.</li>
      <li><strong>Payment records</strong> — what each household owes for the year, any discount or adjustment and the note explaining it, each payment or refund with its date, amount, method (for example &ldquo;Visa ending 4242&rdquo; or &ldquo;bank transfer ending 6789&rdquo;), whether it succeeded, the receipt, and the payment schedule if there is one. We also keep the identifiers Stripe gives us for your household and for a saved payment method.</li>
      <li><strong>Co-op expense records</strong> — what the co-op spends: date, amount, category, vendor, a note, who entered it, and the receipts. These are about the co-op&rsquo;s own spending, not about families, and only administrators can see them.</li>
      <li><strong>Earlier teacher notes</strong> — notes teachers wrote about a student&rsquo;s progress before teachers began messaging parents directly. They are kept, but are no longer shown in the app or added to. Teachers now reach parents through <em>Messages</em> (below).</li>
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
      <li>An administrator can see what&rsquo;s needed to run the co-op: households, classes, enrollment, and compliance status, including each household&rsquo;s dues balance and payment history.</li>
      <li>A household&rsquo;s payment records are visible to the adults in that household and to administrators. Other families, and teachers, cannot see them.</li>
      <li>Curriculum files a teacher attaches to a class are visible to that teaching team only, not to enrolled families.</li>
      <li><strong>Messages</strong> are visible only to the people in that conversation. Administrators cannot browse private conversations. If a member reports a message, administrators can see that message and a few around it so they can judge it, and each time they do, it is recorded in the activity log.</li>
      <li><strong>Photo library</strong> photos are visible either to the whole co-op or to one class (its teachers, the families of enrolled children, and administrators), as chosen when the photo is added. A photo submitted by a parent is reviewed by a teacher of that class or an administrator before anyone else sees it. Anyone who can see a photo can report it, and administrators can remove it.</li>
    </ul>

    <h2>Who we share it with</h2>
    <p>We don&rsquo;t sell or rent family information, and there are no advertising or cross-site tracking tools in the app. A few outside services help run it, and see only what they need to do their job:</p>
    <ul>
      <li><strong>Supabase</strong> — hosts our database, sign-in, file storage (including photos), and live updates.</li>
      <li><strong>Cloudflare</strong> — hosts the web application and provides page-visit counts.</li>
      <li><strong>A time-stamping authority</strong> (DigiCert, unless the co-op changes it) — when a form is finished, it is sent a short fingerprint (a SHA-256 hash) of the signed document and returns a signed time. It never receives the document, a name, or any other detail.</li>
      <li><strong>Stripe</strong> — processes dues payments. When you pay, you enter your card or bank details on Stripe&rsquo;s own page, and Stripe, not the co-op, receives and stores them. Stripe also receives your household name, the email of the adult paying, the amount and what it is for, and it sends its own receipts if the co-op has that turned on. Stripe&rsquo;s handling of that information is covered by <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">Stripe&rsquo;s privacy policy</a>.</li>
      <li><strong>Resend</strong> — sends invitation and reminder emails, so it sees the recipient&rsquo;s name and email address and the message.</li>
      <li><strong>Apple and Google (Firebase Cloud Messaging)</strong> — carry notifications to phones. They see the notification&rsquo;s title and text.</li>
    </ul>

    <h2>Electronic signatures</h2>
    <p>Forms the co-op asks you to sign are signed inside Family Village, while you are signed in to your own account. There is no public signing link and no outside signing service.</p>
    <ul>
      <li><strong>What is recorded</strong> — the document you were sent; that you agreed to sign electronically and the wording you agreed to; your typed or drawn signature and initials and anything you typed into the form; your account name and email; the time; and the IP address and browser details your device used when you opened, agreed and signed. A history of each step (sent, opened, agreed, signed, reminded, sealed, downloaded) is kept, and it cannot be edited or deleted.</li>
      <li><strong>Where it is kept</strong> — in the co-op&rsquo;s own Family Village storage with Supabase, the same private storage as the rest of your records. When everyone has signed, the co-op&rsquo;s system produces one signed PDF with a certificate page listing the signers, times and IP addresses, and stores it there.</li>
      <li><strong>Who can see it</strong> — the adults in your household, the people who signed it, and administrators.</li>
      <li><strong>If you delete your account</strong> — signed forms are records the co-op may need later, so they stay. Your email address is removed from the signing record and your account is deleted, but your name, the times and the IP address stay on the signed form and its history. Signed forms are also not deleted when a household is deleted.</li>
    </ul>
    <p><em>[Flag for legal review: how long signed forms and their history are kept, and whether a parent&rsquo;s electronic signature is enough for liability waivers and other forms that involve a minor.]</em></p>

    <h2>Dues payments</h2>
    <p>Dues can be paid in Family Village by bank transfer, credit or debit card, or Apple Pay or Google Pay, through Stripe. The co-op pays the processing fees; families pay exactly the dues amount.</p>
    <ul>
      <li><strong>What the co-op stores</strong> — the payment records described above, and for a saved payment method only its type, brand or bank name, last four digits and Stripe&rsquo;s identifier for it. Not the full number.</li>
      <li><strong>Automatic monthly payments</strong> — only if you choose the monthly plan and agree on the checkout page. The co-op then collects each installment on its due date from the method you used. You can stop automatic payments in Family Village at any time, and a saved method is removed from Stripe if you remove it or erase your account.</li>
      <li><strong>Reminders and receipts</strong> — we send reminders before an installment is due and a message if a payment fails. Every payment has a receipt you can download in Family Village.</li>
      <li><strong>Practice mode</strong> — before the co-op takes real payments it tests with Stripe&rsquo;s test cards. Test payments move no money and are marked as tests.</li>
    </ul>
    <p><em>[Flag for legal review: the wording of the authorization for recurring bank (ACH) debits; whether and how receipts should describe tax treatment (the co-op&rsquo;s CPA should decide, and the receipt text is editable by an administrator); and how long payment, receipt and expense records must be kept.]</em></p>

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
      <li>You can permanently delete your account in Account Settings, or by email to <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a>; see <a href="/delete-account">how to delete your account</a>. That erases your sign-in, contact details, photo, devices and messages. Notes, news posts and library photos you added stay without your name, your household&rsquo;s records stay if another adult is in it, and <strong>payment records always stay</strong> because the co-op must keep its financial records: if you were the last adult, the household remains in the co-op&rsquo;s books as &ldquo;Former household&rdquo; with its children&rsquo;s details removed, and your name, email and saved payment method are removed from Stripe. <em>[Flag for legal review: the response time for email requests, and which records the co-op must keep.]</em></li>
    </ul>

    <h2>How long we keep it</h2>
    <p>Payment, receipt and expense records are kept as financial records of the co-op and are not deleted when a person or household leaves. Messages and photos stay until the person who added them or an administrator removes them. Removing a message or photo erases its content and its files, and deleting an account erases the messages that person sent. <em>[Flag for legal review: the co-op should decide and state a real retention policy here — for example, how long records are kept after a family leaves, and when messages are deleted automatically.]</em></p>

    <h2>How we protect it</h2>
    <p>The app uses encrypted connections. Signing in is required, access is limited by role, and photos and files are kept in private storage that requires a signed-in account with permission to see them. Passkeys and two-factor sign-in are available. No system is perfectly secure, so please use a strong password or a passkey and keep your sign-in private.</p>

    <h2>Changes</h2>
    <p>We&rsquo;ll update this page when the app changes, and tell members in the app when a change matters.</p>

    <h2>Questions</h2>
    <p>Questions about this policy or your family&rsquo;s information can go to <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a>.</p>
  </main>

  <footer><span>Veritas Village</span><span>Learning in truth. Growing in community.</span><span>Central Texas</span></footer>
</>; }
