"use client";

type Tab = "invitations" | "families" | "classes" | "documents" | "news" | "reports" | "activity" | "integrations";

const CARDS: { eyebrow: string; number: string; title: string; description: string; button: string; tab: Tab }[] = [
  { eyebrow: "Accounts", number: "01", title: "Invite a family", description: "Send an expiring invitation, then connect the accepted account to the correct household.", button: "Create invitation", tab: "invitations" },
  { eyebrow: "Relationships", number: "02", title: "Assign roles and children", description: "A parent may also be a teacher. Each role adds permissions without creating duplicate accounts.", button: "Manage access", tab: "families" },
  { eyebrow: "Classes", number: "03", title: "Build rosters", description: "Build the timetable, set grades and electives, and open enrollment windows for families.", button: "Manage classes", tab: "classes" },
  { eyebrow: "Documents", number: "04", title: "Send documents for signature", description: "Upload a PDF, place signature fields, send it to families to sign in the portal, and see who still needs to sign.", button: "Open documents", tab: "documents" },
  { eyebrow: "Publishing", number: "05", title: "Share news and calendar", description: "Publish stories, media, and co-op-wide calendar events for the right audience.", button: "Create or schedule", tab: "news" },
  { eyebrow: "Reports", number: "06", title: "Print what you need", description: "Prepare family-readiness, class, and roster reports from current portal records.", button: "Open reports", tab: "reports" },
  { eyebrow: "Oversight", number: "07", title: "Review activity", description: "Important access and administrative changes are recorded for accountability.", button: "View activity", tab: "activity" },
  { eyebrow: "Configuration", number: "08", title: "Connect your tools", description: "Email delivery, the office printer and the Facebook group link. Signing is built in and lives under Documents.", button: "Manage integrations", tab: "integrations" },
];

export default function AdminDashboard({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  return <div className="dashboard-grid">
    {CARDS.map((card) => <article className="dashboard-card" key={card.number}>
      <div className="dashboard-card-top"><p className="card-kicker">{card.eyebrow}</p><span className="dashboard-card-number">{card.number}</span></div>
      <h2>{card.title}</h2>
      <p>{card.description}</p>
      <button onClick={() => onNavigate(card.tab)}>{card.button}</button>
    </article>)}
  </div>;
}
