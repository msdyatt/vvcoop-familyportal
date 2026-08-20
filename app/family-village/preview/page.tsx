import Link from "next/link";

const groupUrl = "https://www.facebook.com/groups/960994296456160";

const sections = ["Home", "My children", "Classes", "Calendar", "Village news", "Media", "Documents"];

export const metadata = {
  title: "Family Village Preview | Veritas Village",
  description: "A preview of the private Veritas Village family portal.",
};

export default function FamilyVillagePreview() {
  return <div className="portal-shell">
    <aside className="portal-sidebar"><Link className="portal-wordmark" href="/">Veritas <span>Village</span></Link><p>Family Village</p><nav aria-label="Family portal preview">{sections.map((section, index) => <a className={index === 0 ? "active" : ""} href={`#${section.toLowerCase().replaceAll(" ", "-")}`} key={section}>{section}</a>)}</nav><div className="account-chip"><span>Preview</span><small>No family data</small></div></aside>
    <main className="portal-dashboard">
      <header><div><p className="eyebrow">Family portal preview</p><h1>Your village, gathered.</h1></div><div className="preview-switch"><a href="/family-village/teacher">Teacher view</a><a href="/family-village/admin">Admin view</a><a href="/family-village">Finish preview</a></div></header>
      <div className="preview-banner"><b>This is a privacy-safe preview.</b> Real names, notes, photographs, and paperwork will appear only after secure sign-in and administrative approval.</div>

      <section id="home" className="dashboard-grid">
        <article className="dashboard-card welcome-card"><p className="card-kicker">This week</p><h2>Ready for Friday.</h2><p>Your family’s next co-op day, current classes, open assignments, and reminders will gather here.</p><div className="friday-row"><time>9:45</time><span>Arrival + setup</span><time>10:00</time><span>History begins</span></div></article>
        <article className="dashboard-card action-card"><p className="card-kicker">Family checklist</p><h2>Nothing needs attention.</h2><p>Forms, unread notes, supply reminders, and upcoming deadlines will appear here.</p><span className="empty-pill">All caught up</span></article>
      </section>

      <section id="my-children" className="portal-section"><div className="section-heading"><div><p className="card-kicker">My children</p><h2>One view for every learner.</h2></div><p>Each child is linked to approved parents or guardians, their classes, assignments, and teacher notes.</p></div><div className="child-grid"><article className="child-card"><div className="initial">+</div><h3>Children appear here</h3><p>An administrator connects each child to the right family account.</p><span>Private by default</span></article><article className="child-card muted"><p className="card-kicker">A child’s view includes</p><ul><li>Current classes and teachers</li><li>Assignments and resources</li><li>Family-visible teacher notes</li><li>Attendance and schedule</li></ul></article></div></section>

      <section id="classes" className="portal-section"><div className="section-heading"><div><p className="card-kicker">Classes</p><h2>A clear path through the day.</h2></div><p>Only classes connected to your family appear here.</p></div><div className="class-list"><article><time>10:00</time><div><h3>History</h3><p>Teacher, room, weekly plan, and materials will appear here.</p></div><span>Core study</span></article><article><time>11:00</time><div><h3>Science</h3><p>Teacher notes, experiments, and supply reminders will appear here.</p></div><span>Core study</span></article><article><time>1:00 + 2:00</time><div><h3>Electives</h3><p>Your child’s semester electives will appear after placement.</p></div><span>By placement</span></article></div></section>

      <section id="calendar" className="portal-section split-section"><div><p className="card-kicker">Calendar</p><h2>Plans families can trust.</h2><p>The private calendar can include co-op days, deadlines, field trips, teacher meetings, and locations without publishing them to the open web.</p><div className="calendar-placeholder"><span>Shared calendar connection</span><b>Ready for the approved calendar link</b></div></div><div id="village-news"><p className="card-kicker">Village news</p><h2>News that stays findable.</h2><p>Announcements can be written once, pinned when important, and shared with all families or selected classes.</p><a className="facebook-out" href={groupUrl} target="_blank" rel="noreferrer">Open the private Facebook group ↗</a><small>Facebook remains a link-out; private group posts are not copied or exposed.</small></div></section>

      <section id="media" className="portal-section"><div className="section-heading"><div><p className="card-kicker">Media</p><h2>Shared with permission.</h2></div><p>Albums can be restricted by family, class, or the whole co-op, with consent recorded before a photo is shown.</p></div><div className="media-empty"><span>◇</span><p>Private class and community albums will live here.</p><small>No photographs have been added to this preview.</small></div></section>

      <section id="documents" className="portal-section"><div className="section-heading"><div><p className="card-kicker">Documents</p><h2>Paperwork, without the paper chase.</h2></div><p>Families can find their signed records alongside clean copies of current co-op documents.</p></div><div className="document-list"><article><div><b>Family handbook</b><small>Current approved edition</small></div><span>Private copy</span></article><article><div><b>Liability waiver</b><small>Signed status and completed copy</small></div><span>OpenSign-ready</span></article><article><div><b>Photo permissions</b><small>Consent by child and intended audience</small></div><span>Required for media</span></article></div></section>
    </main>
  </div>;
}
