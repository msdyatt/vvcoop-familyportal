import type { Metadata } from "next";
import PublicSiteFrame from "../public-site-frame";

export const metadata: Metadata = {
  title: "About Veritas Village | Central Texas Homeschool Co-op",
  description: "Learn about Veritas Village, a parent-led 501(c)(3) nonprofit homeschool co-op serving families in Central Texas.",
};

export default function AboutPage() {
  return (
    <PublicSiteFrame>
      <section className="public-hero">
        <p className="eyebrow">About our nonprofit</p>
        <h1>Learning in truth.<br /><em>Growing in community.</em></h1>
        <p className="public-lead">Veritas Village is a parent-led homeschool co-op bringing Central Texas families together for shared learning, service, and friendship.</p>
      </section>

      <section className="public-content-grid" aria-labelledby="mission-heading">
        <div className="public-section-intro"><p className="eyebrow">Our purpose</p><h2 id="mission-heading">A village built by families.</h2></div>
        <div className="public-body">
          <p>Our mission is to bring Central Texas homeschool families together for shared classes, electives, and time to know one another.</p>
          <p>Parents teach and help run the day. Children learn with friends, try new things, and grow in a community that makes room for different ages, interests, and family rhythms.</p>
          <p>We believe learning is stronger when families share their talents, their effort, and their curiosity.</p>
          <a className="public-text-link" href="/programs">Explore our programs →</a>
        </div>
      </section>

      <section className="public-panel" aria-labelledby="structure-heading">
        <p className="eyebrow">How our co-op works</p>
        <h2 id="structure-heading">Shared responsibility. Shared discovery.</h2>
        <div className="public-card-grid">
          <article className="public-card"><span className="public-card-index">01</span><h3>Parent-led</h3><p>Families help teach, assist, and support the day. This is not a drop-off program.</p></article>
          <article className="public-card"><span className="public-card-index">02</span><h3>Many ages</h3><p>Our learning community welcomes preschool through high-school students, with flexibility for individual needs.</p></article>
          <article className="public-card"><span className="public-card-index">03</span><h3>Learning together</h3><p>History and science studies form the year&apos;s foundation, with electives shaped by families&apos; interests and abilities.</p></article>
        </div>
      </section>

      <section className="public-content-grid public-legal" aria-labelledby="organization-heading">
        <div className="public-section-intro"><p className="eyebrow">Organization details</p><h2 id="organization-heading">Rooted in Central Texas.</h2></div>
        <div className="public-body">
          <dl className="public-details">
            <div><dt>Registered nonprofit name</dt><dd>VERITAS VILLAGE (Veritas Village Co-op)</dd></div>
            <div><dt>Nonprofit status</dt><dd>501(c)(3) nonprofit organization</dd></div>
            <div><dt>Charity ID / EIN</dt><dd>42-2025384</dd></div>
            <div><dt>Official website</dt><dd><a href="https://veritasvillage.org/">veritasvillage.org</a></dd></div>
            <div><dt>Registered physical business address</dt><dd>509 Las Colinas Drive, Leander, Texas</dd></div>
          </dl>
          <p className="public-fine-print">This is the organization&apos;s administrative address, not a public classroom or drop-in location. Please contact the co-op before planning any visit.</p>
          <a className="public-text-link" href="/contact">Contact our organization →</a>
        </div>
      </section>
      <section className="public-cta"><p className="eyebrow">Join the conversation</p><h2>There&apos;s room to grow together.</h2><p>Curious about what a day at Veritas Village looks like?</p><a href="/contact" className="public-button">Get in touch →</a></section>
    </PublicSiteFrame>
  );
}
