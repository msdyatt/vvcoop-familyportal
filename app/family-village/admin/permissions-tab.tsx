"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { ADMIN_PERMISSIONS, PERMISSION_LABELS, refreshAdminAccess, type AdminPermission, type AdminTier } from "../../../lib/admin-access";
import AskBoardAdmin from "./ask-board-admin";

type CatalogEntry = { key: AdminPermission; label: string; description: string; board_default: boolean; admin_default: boolean };
type AdminRow = { user_id: string; name: string; email: string; tier: AdminTier; permissions: Record<AdminPermission, boolean>; overrides: Partial<Record<AdminPermission, boolean>> };
type LogRow = { id: number; at: string; action: string; permission: AdminPermission | null; old_value: string | null; new_value: string | null; actor: string; subject: string };
type Overview = { can_manage: boolean; me: string; catalog: CatalogEntry[]; admins: AdminRow[]; log: LogRow[] };

const TIER_LABEL: Record<AdminTier, string> = { board: "Board admin", admin: "Admin" };

function describe(row: LogRow): string {
  const label = row.permission ? PERMISSION_LABELS[row.permission] : "";
  const tier = (value: string | null) => (value === "board" || value === "admin" ? TIER_LABEL[value] : value ?? "");
  switch (row.action) {
    case "seeded": return `${row.subject} became a board admin when permissions were turned on.`;
    case "admin_added": return `${row.actor} made ${row.subject} an admin.`;
    case "admin_removed": return `${row.actor} removed ${row.subject}'s admin role.`;
    case "tier_changed": return `${row.actor} moved ${row.subject} from ${tier(row.old_value)} to ${tier(row.new_value)}.`;
    case "permission_granted": return `${row.actor} gave ${row.subject} "${label}".`;
    case "permission_revoked": return `${row.actor} took "${label}" away from ${row.subject}.`;
    case "permission_default": return `${row.actor} set ${row.subject}'s "${label}" back to the tier default (${row.new_value === "true" ? "on" : "off"}).`;
    default: return `${row.actor}: ${row.action} for ${row.subject}.`;
  }
}

/** Admin, Settings, Admin permissions: who is a board admin, and the five board-only permissions per person. */
export default function PermissionsTab() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: loadError } = await supabase.rpc("admin_permissions_overview");
    if (loadError) { setError(loadError.message); return; }
    setError("");
    setOverview(data as Overview);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function run(fn: string, args: Record<string, unknown>, done: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus("");
    const { error: runError } = await supabase.rpc(fn, args);
    setBusy(false);
    setStatus(runError ? runError.message : done);
    await load();
    refreshAdminAccess();
  }

  if (error) {
    return error.startsWith("Ask a board admin")
      ? <section className="permissions-manage"><h2>Admin permissions</h2><AskBoardAdmin permission="manage_permissions">Only board admins can see who holds which permissions.</AskBoardAdmin></section>
      : <p className="admin-form-status" role="status">{error}</p>;
  }
  if (!overview) return <p>Loading admin permissions…</p>;

  const { can_manage: canManage, catalog, admins, log } = overview;

  return <section className="permissions-manage">
    <h2>Admin permissions</h2>
    <p>Board admins have all five permissions below. Admins handle the day-to-day work (families, classes, messages, calendar and the rest) and have none of the five unless a board admin turns one on for them. At least one board admin must always keep &ldquo;Admin permissions&rdquo;.</p>
    <p className="field-note">To make someone an admin or remove the role, use Families. That also needs &ldquo;Admin permissions&rdquo;.</p>
    {!canManage && <AskBoardAdmin permission="manage_permissions">You can see this list, but changing it needs the &ldquo;Admin permissions&rdquo; permission.</AskBoardAdmin>}
    <p className="admin-form-status" role="status">{status}</p>

    <div className="scroller">
      <table className="permissions-table">
        <thead>
          <tr>
            <th scope="col">Admin</th>
            <th scope="col">Tier</th>
            {catalog.map((c) => <th scope="col" key={c.key} title={c.description}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {admins.map((a) => <tr key={a.user_id}>
            <th scope="row"><b>{a.name}</b>{a.user_id === overview.me && <span className="field-note"> (you)</span>}<br /><span className="field-note">{a.email}</span></th>
            <td>
              <select aria-label={`Tier for ${a.name}`} value={a.tier} disabled={!canManage || busy}
                onChange={(e) => run("admin_set_admin_tier", { p_user: a.user_id, p_tier: e.target.value }, `${a.name} is now ${TIER_LABEL[e.target.value as AdminTier].toLowerCase()}.`)}>
                <option value="board">{TIER_LABEL.board}</option>
                <option value="admin">{TIER_LABEL.admin}</option>
              </select>
            </td>
            {ADMIN_PERMISSIONS.map((key) => {
              const on = a.permissions[key];
              const changed = key in a.overrides;
              return <td key={key} className={changed ? "permission-changed" : undefined}>
                <label className="permission-switch">
                  <input type="checkbox" checked={on} disabled={!canManage || busy}
                    aria-label={`${PERMISSION_LABELS[key]} for ${a.name}`}
                    onChange={(e) => run("admin_set_admin_permission", { p_user: a.user_id, p_permission: key, p_granted: e.target.checked },
                      `${PERMISSION_LABELS[key]} ${e.target.checked ? "turned on" : "turned off"} for ${a.name}.`)} />
                  <span>{on ? "On" : "Off"}{changed && <small> (not the {a.tier === "board" ? "board" : "admin"} default)</small>}</span>
                </label>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>

    <dl className="permissions-key">
      {catalog.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{c.description}</dd></div>)}
    </dl>

    <h3>Recent changes</h3>
    {log.length
      ? <ol className="permissions-log">{log.map((row) => <li key={row.id}><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time> {describe(row)}</li>)}</ol>
      : <p>No changes yet.</p>}
  </section>;
}
