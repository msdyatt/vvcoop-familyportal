import type { Metadata } from "next";
import PublicSiteFrame from "../public-site-frame";
import { calendarSubscribeUrl, googleCalendarAddUrl } from "../../lib/supabase";

export const metadata: Metadata = {
  title: "Programs & Schedule | Veritas Village",
  description: "Discover the parent-led history, science, and elective classes at Veritas Village, a Central Texas homeschool co-op.",
};

export default function ProgramsPage() {
  return (
    <PublicSiteFrame>
      <section className="public-hero">
        <p className="eyebrow">Our programs</p>
        <h1>Curiosity has<br /><em>room to roam.</em></h1>
        <p className="public-lead">Our 26-week homeschool co-op year gives students opportunities to learn together through shared classes, hands-on exploration, and family-led electives.</p>
      </section>

      <section className="public-panel" aria-labelledby="learning-heading">
        <p className="eyebrow">What we study</p><h2 id="learning-heading">A shared foundation, many discoveries.</h2>
        <div className="public-card-grid">
          <article className="public-card"><span className="public-card-index">01</span><h3>History</h3><p>Families come together for history studies, building understanding through shared lessons and discussion.</p></article>
          <article className="public-card"><span className="public-card-index">02</span><h3>Science</h3><p>Science gives children opportunities to ask questions, explore ideas, and learn alongside friends.</p></article>
          <article className="public-card"><span className="public-card-index">03</span><h3>Electives</h3><p>Parent-led electives change as families bring their skills, interests, and ideas to the group.</p></article>
        </div>
      </section>

      <section className="public-content-grid" aria-labelledby="day-heading">
        <div className="public-section-intro"><p className="eyebrow">Our shared rhythm</p><h2 id="day-heading">A day at the village.</h2><p>We meet from 9:45 AM to 3:15 PM, with classes, lunch, play, and time to care for our shared space.</p></div>
        <div className="public-body">
          <ol className="public-schedule">
            <li><time>9:45 AM</time><span>Arrival and setup</span></li>
            <li><time>10:00 AM</time><span>History</span></li>
            <li><time>11:00 AM</time><span>Science</span></li>
            <li><time>12:00 PM</time><span>Lunch</span></li>
            <li><time>1:00 PM</time><span>Elective</span></li>
            <li><time>2:00 PM</time><span>Elective</span></li>
            <li><time>3:00 PM</time><span>Cleanup</span></li>
          </ol>
          <div className="public-link-row"><a className="public-text-link" href={calendarSubscribeUrl("scope=public")}>Subscribe to the public calendar ↗</a><a className="public-text-link" href={googleCalendarAddUrl("scope=public")} target="_blank" rel="noreferrer">Add to Google Calendar ↗</a></div>
        </div>
      </section>

      <section className="public-content-grid public-legal" aria-labelledby="participation-heading">
        <div className="public-section-intro"><p className="eyebrow">For prospective families</p><h2 id="participation-heading">Families make the village.</h2></div>
        <div className="public-body">
          <p>We welcome learners from preschool through high school. Groups may shift when a child needs a different pace or setting.</p>
          <p>At least one adult from each family stays on site to teach or help. Participation requires a liability waiver, and enrollment depends on available space and director approval.</p>
          <dl className="public-details">
            <div><dt>Co-op year</dt><dd>26 weeks</dd></div>
            <div><dt>Family tuition</dt><dd>$300 per family, per year</dd></div>
            <div><dt>Student tuition</dt><dd>$150 per child, per year</dd></div>
            <div><dt>Family role</dt><dd>Teach, assist, and stay on site</dd></div>
          </dl>
          <a className="public-text-link" href="/contact">Ask about enrollment →</a>
        </div>
      </section>
      <section className="public-cta"><p className="eyebrow">Questions are welcome</p><h2>Come curious.</h2><p>Ask us about the co-op day, classes, and enrollment.</p><a href="/contact" className="public-button">Contact Veritas Village →</a></section>
    </PublicSiteFrame>
  );
}
