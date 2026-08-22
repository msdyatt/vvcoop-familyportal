"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

type Integration = { id: string; display_name: string; status: string; public_note: string | null; external_url: string | null; api_base_url: string | null };

export default function IntegrationsTab({ actorUserId }: { actorUserId: string }) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("integration_settings").select("id,display_name,status,public_note,external_url,api_base_url").order("display_name");
    if (!error) setIntegrations((data ?? []) as Integration[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function save(row: Integration) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("integration_settings").update({
      status: row.status, public_note: row.public_note, external_url: row.external_url, api_base_url: row.api_base_url, updated_by: actorUserId,
    }).eq("id", row.id);
    if (error) { setStatus(error.message); return; }
    setStatus(`Saved ${row.display_name}.`);
    await load();
  }

  if (loading) return <p>Loading integrations…</p>;

  return <section className="integrations-manage">
    <p className="admin-form-status" role="status">{status || "Most rows here track connection status only. OpenSign is live: set its API base URL below, and a Village administrator must set the OPENSIGN_API_TOKEN and OPENSIGN_WEBHOOK_SECRET secrets on the server."}</p>
    <aside className="integration-help">
      <p className="card-kicker">OpenSign setup</p>
      <ol>
        <li><b>API base URL</b> — <code>https://app.opensignlabs.com/api/v1.2</code> for the hosted service, <code>https://eu-app.opensignlabs.com/api/v1.2</code> in the EU, or your own origin plus <code>/api/v1.2</code> if you self-host. Set it in the OpenSign row below.</li>
        <li><b>API token</b> — OpenSign → Settings → API Token. Set it as the <code>OPENSIGN_API_TOKEN</code> server secret. It is never stored in this database and never reaches the browser.</li>
        <li><b>Webhook, last</b> — OpenSign only issues a signing key once a live webhook URL is registered, so this step comes after the functions are deployed. In OpenSign → Settings → Webhook, add the deployed <code>opensign-webhook</code> URL, enable authentication, generate the key, then set it as <code>OPENSIGN_WEBHOOK_SECRET</code>.</li>
      </ol>
      <p>Sending works as soon as the base URL and API token are set. Until the webhook secret is in place, signature completions will not flow back on their own and statuses stay at <b>sent</b>.</p>
    </aside>
    <div className="integrations-list">
      {integrations.map((row) => <IntegrationCard key={row.id} row={row} onSave={save} />)}
    </div>
  </section>;
}

function IntegrationCard({ row, onSave }: { row: Integration; onSave: (row: Integration) => void }) {
  const [local, setLocal] = useState(row);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLocal(row); }, [row]);

  return <article className="integration-card">
    <div className="integration-card-head">
      <h3>{local.display_name}</h3>
      <select value={local.status} onChange={(event) => setLocal({ ...local, status: event.target.value })}>
        <option value="not_configured">Not configured</option>
        <option value="pending">Pending</option>
        <option value="connected">Connected</option>
        <option value="attention">Needs attention</option>
      </select>
    </div>
    <label>Note<textarea value={local.public_note ?? ""} onChange={(event) => setLocal({ ...local, public_note: event.target.value })} /></label>
    <div className="field-row">
      <label>External URL<input value={local.external_url ?? ""} onChange={(event) => setLocal({ ...local, external_url: event.target.value })} placeholder="https://…" /></label>
      <label>API base URL<input value={local.api_base_url ?? ""} onChange={(event) => setLocal({ ...local, api_base_url: event.target.value })} placeholder="https://api…" /></label>
    </div>
    <button onClick={() => onSave(local)}>Save</button>
  </article>;
}
