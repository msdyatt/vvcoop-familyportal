"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

type Integration = { id: string; display_name: string; status: string; public_note: string | null; external_url: string | null; api_base_url: string | null };

/**
 * Every row here is real -- both OpenSign and the Facebook group link are
 * actually read by the app. This page used to list six services, five of
 * which nothing was wired to; a page that implies five connections exist
 * when one does is worse than a short one that's telling the truth. If a new
 * service gets genuinely integrated later, it earns a row here then.
 */
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

  /**
   * Asks the server whether OpenSign accepts the stored API token.
   *
   * The token lives in a server secret, so the browser cannot check it and an
   * administrator otherwise has no way to tell a wrong token from a quiet one.
   * That ambiguity is exactly what let this integration sit broken.
   */
  async function testOpenSign() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setStatus("Testing the OpenSign connection…");
    const { data, error } = await supabase.functions.invoke("opensign-sync", { body: { mode: "test" } });
    if (error) { setStatus(`Could not run the test: ${error.message}`); return; }
    setStatus(data?.detail ?? (data?.ok ? "OpenSign accepted the API token." : "OpenSign rejected the API token."));
    await load();
  }

  if (loading) return <p>Loading integrations…</p>;

  return <section className="integrations-manage">
    <p className="admin-form-status" role="status">{status || "Everything on this page is a real, working connection."}</p>
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
      {integrations.map((row) => <IntegrationCard
        key={row.id} row={row} onSave={save}
        live={row.id === "opensign"}
        onTest={row.id === "opensign" ? testOpenSign : undefined}
        showApiBase={row.id === "opensign"}
      />)}
    </div>
  </section>;
}

function IntegrationCard({ row, onSave, live = false, onTest, showApiBase = false }: {
  row: Integration; onSave: (row: Integration) => void; live?: boolean; onTest?: () => void; showApiBase?: boolean;
}) {
  const [local, setLocal] = useState(row);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLocal(row); }, [row]);

  return <article className="integration-card">
    <div className="integration-card-head">
      <h3>{local.display_name}{live && <span className="live-badge">live</span>}</h3>
      <select value={local.status} onChange={(event) => setLocal({ ...local, status: event.target.value })}>
        <option value="not_configured">Not configured</option>
        <option value="pending">Pending</option>
        <option value="connected">Connected</option>
        <option value="attention">Needs attention</option>
      </select>
    </div>
    <label>Note<textarea value={local.public_note ?? ""} onChange={(event) => setLocal({ ...local, public_note: event.target.value })} /></label>
    <div className="field-row">
      <label>{row.id === "facebook" ? "Group URL — shown on the site" : "External URL"}
        <input value={local.external_url ?? ""} onChange={(event) => setLocal({ ...local, external_url: event.target.value })} placeholder="https://…" />
      </label>
      {showApiBase && <label>API base URL<input value={local.api_base_url ?? ""} onChange={(event) => setLocal({ ...local, api_base_url: event.target.value })} placeholder="https://api…" /></label>}
    </div>
    {live && <p className="field-note">
      This base URL is read by the signing function every time a document is sent — changing it changes real behaviour.
    </p>}
    {row.id === "facebook" && <p className="field-note">
      This link is what shows on the public site and in the family portal — saving it here updates it everywhere at once.
    </p>}
    <div className="row-actions">
      <button onClick={() => onSave(local)}>Save</button>
      {onTest && <button type="button" className="ghost" onClick={onTest}>Test connection</button>}
    </div>
  </article>;
}
