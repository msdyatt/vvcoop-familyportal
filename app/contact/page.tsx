import type { Metadata } from "next";
import PublicSiteFrame from "../public-site-frame";

export const metadata: Metadata = {
  title: "Contact Veritas Village | Central Texas Homeschool Co-op",
  description: "Contact Veritas Village Co-op, a 501(c)(3) nonprofit serving Central Texas homeschool families. Find our official organization email and registered address.",
};

export default function ContactPage() {
  return (
    <PublicSiteFrame>
      <section className="public-hero">
        <p className="eyebrow">Contact our co-op</p>
        <h1>Every village starts<br /><em>with a conversation.</em></h1>
        <p className="public-lead">Have a question about our homeschool co-op, participating as a family, or how our day works? We'd love to hear from you.</p>
      </section>
      <section className="public-content-grid" aria-labelledby="contact-heading">
        <div className="public-section-intro"><p className="eyebrow">Official contact</p><h2 id="contact-heading">Get in touch.</h2><p>Use the organization's contact email for enrollment questions, general inquiries, and nonprofit correspondence.</p></div>
        <div className="public-body">
          <div className="public-contact-card">
            <p className="public-detail-label">Veritas Village Co-op — official organization email</p>
            <a className="public-email" href="mailto:veritasvillagecoop@gmail.com">veritasvillagecoop@gmail.com</a>
            <a className="public-button" href="mailto:veritasvillagecoop@gmail.com?subject=Inquiry%20for%20Veritas%20Village">Email the co-op →</a>
          </div>
          <p className="public-fine-print">This is the organization-managed contact address currently in use while we complete activation of email at veritasvillage.org.</p>
        </div>
      </section>
      <section className="public-content-grid public-legal" aria-labelledby="registered-heading">
        <div className="public-section-intro"><p className="eyebrow">Nonprofit transparency</p><h2 id="registered-heading">Our registered details.</h2></div>
        <div className="public-body">
          <dl className="public-details">
            <div><dt>Legal nonprofit name</dt><dd>VERITAS VILLAGE (Veritas Village Co-op)</dd></div>
            <div><dt>Charity ID / EIN</dt><dd>42-2025384</dd></div>
            <div><dt>Physical business address</dt><dd><address>509 Las Colinas Drive<br />Leander, Texas</address></dd></div>
            <div><dt>Primary domain</dt><dd><a href="https://veritasvillage.org/">veritasvillage.org</a></dd></div>
          </dl>
          <p className="public-fine-print">The address above is our administrative registration address, not the co-op's class location. We cannot accommodate unscheduled visits or drop-offs there. Please email us to arrange any in-person contact.</p>
        </div>
      </section>
      <section className="public-cta"><p className="eyebrow">Learn more</p><h2>A community built together.</h2><p>Explore our mission and programs before getting in touch.</p><div className="public-link-row centered"><a className="public-button" href="/about">About us →</a><a className="public-button secondary" href="/programs">Our programs →</a></div></section>
    </PublicSiteFrame>
  );
}
