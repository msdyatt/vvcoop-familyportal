"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

type AuditRow = { id: number; actor_user_id: string; action: string; subject_type: string; subject_id: string; detail: Record<string, unknown> | null; created_at: string; actor_name: string };

export default function ActivityTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("audit_log").select("id,actor_user_id,action,subject_type,subject_id,detail,created_at").order("created_at", { ascending: false }).limit(60);
    const base = (data ?? []) as Omit<AuditRow, "actor_name">[];
    const actorIds = [...new Set(base.map((row) => row.actor_user_id))];
    const { data: profileRows } = actorIds.length ? await supabase.from("profiles").select("id,display_name,email").in("id", actorIds) : { data: [] };
    const nameMap = new Map((profileRows ?? []).map((row) => [row.id, row.display_name || row.email]));
    setRows(base.map((row) => ({ ...row, actor_name: nameMap.get(row.actor_user_id) ?? "Someone" })));
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  if (loading) return <p>Loading activity…</p>;

  const actionLabels: Record<string, string> = {
    family_updated: "updated a household",
    child_updated: "updated a child record",
    child_added: "added a child",
    child_deactivated: "deactivated a child",
    user_removed: "removed a user's access",
    role_granted: "granted a role",
    role_revoked: "revoked a role",
  };

  return <section className="activity-log">
    {rows.map((row) => <article className="activity-row" key={row.id}>
      <div><b>{row.actor_name}</b> {actionLabels[row.action] ?? row.action}</div>
      <span>{new Date(row.created_at).toLocaleString()}</span>
      {row.detail && Object.keys(row.detail).length > 0 && <code>{JSON.stringify(row.detail)}</code>}
    </article>)}
    {!rows.length && <p className="portal-empty">No activity recorded yet.</p>}
  </section>;
}
