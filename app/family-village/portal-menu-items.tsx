import { availableDestinations } from "../../lib/nav-prefs";

/**
 * The portal's Menu: one flat list, Family and Teaching items together, then Admin set apart (admins only).
 * Shared by the apps' Menu sheet and the header menu in a browser, so there is one definition of the list.
 * Calendar, Photos and Messages are ordinary items: nothing is labelled "everywhere".
 */
export default function PortalMenuItems({ roles, onNavigate }: { roles: string[]; onNavigate?: () => void }) {
  const pool = availableDestinations(roles);
  const portal = pool.filter((d) => d.area === "portal");
  const admin = pool.filter((d) => d.area === "admin");
  return <>
    {portal.map((d) => <li key={d.id}><a href={d.href} onClick={onNavigate}>{d.label}</a></li>)}
    {admin.length > 0 && <li className="app-menu-admin">
      <p><span className="admin-chip">Admin</span> Administration area</p>
      <ul>{admin.map((d) => <li key={d.id}><a className="app-menu-sub" href={d.href} onClick={onNavigate}>{d.label}</a></li>)}</ul>
    </li>}
  </>;
}
