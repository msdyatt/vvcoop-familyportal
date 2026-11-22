import PortalFrame from "./portal-frame";

/**
 * Every Family Village page sits in this layout, so moving between them keeps the header, sidebar and bell mounted
 * and swaps only the page (app/family-village/portal-frame.tsx).
 */
export default function FamilyVillageLayout({ children }: { children: React.ReactNode }) {
  return <PortalFrame>{children}</PortalFrame>;
}
