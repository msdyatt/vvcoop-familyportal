"use client";

type Tab = "invitations" | "families" | "classes" | "documents" | "compliance" | "news" | "activity" | "integrations";

const CARDS: { eyebrow: string; number: string; title: string; description: string; button: string; tab: Tab }[] = [
  { eyebrow: "Accounts", number: "01", title: "Invite a family", description: "Send an expiring invitation, then connect the accepted account to the correct household.", button: "Create invitation", tab: "invitations" },
  { eyebrow: "Relationships", number: "02", title: "Assign roles and children", description: "A parent may also be a teacher. Each role adds permissions without creating duplicate accounts.", button: "Manage access", tab: "families" },
  { eyebrow: "Classes", number: "03", title: "Build rosters", description: "Place children, assign lead teachers and assistants, and restrict class records to the right people.", button: "Manage classes", tab: "classes" },
  { eyebrow: "Documents", number: "04", title: "Track signed records", description: "Store private copies, signature status, and provider references without exposing documents publicly.", button: "Open paperwork", tab: "documents" },
  { eyebrow: "Compliance", number: "05", title: "See who is up to date", description: "Which families have signed the handbook and paid their dues, and which still owe something.", button: "Open compliance", tab: "compliance" },
  { eyebrow: "Publishing", number: "06", title: "Share news and media", description: "Choose public, all-family, teacher, class, or household audiences for what you publish.", button: "Create post", tab: "news" },
  { eyebrow: "Oversight", number: "07", title: "Review activity", description: "Important access and administrative changes are recorded for accountability.", button: "View activity", tab: "activity" },
  { eyebrow: "Configuration", number: "08", title: "Connect your tools", description: "Track connection status for Google Workspace, OpenSign, the shared calendar, and dues collection.", button: "Manage integrations", tab: "integrations" },
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
