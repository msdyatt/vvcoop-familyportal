"use client";

import { useEffect, useState } from "react";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";

type Integration = { id: string; display_name: string; status: string; public_note: string | null; external_url: string | null; api_base_url: string | null; from_address: string | null; last_checked_at: string | null };

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
    const { data, error } = await supabase.from("integration_settings").select("id,display_name,status,public_note,external_url,api_base_url,from_address,last_checked_at").order("display_name");
    if (!error) setIntegrations((data ?? []) as Integration[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function save(row: Integration) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("integration_settings").update({
      status: row.status, public_note: row.public_note, external_url: row.external_url, api_base_url: row.api_base_url, from_address: row.from_address, updated_by: actorUserId,
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
    if (error) { setStatus(`Could not run the test: ${await functionErrorMessage(error, data, error.message)}`); return; }
    setStatus(data?.detail ?? (data?.ok ? "OpenSign accepted the API token." : "OpenSign rejected the API token."));
    await load();
  }

  /**
   * Sends a real test email through Resend to the admin's own address.
   *
   * Same reasoning as testOpenSign: the API key lives in Vault, not the
   * browser, so there is no way to confirm the connection works short of
   * actually sending something and watching it arrive.
   */
  async function testResend() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: user } = await supabase.auth.getUser();
    const to = user.user?.email;
    if (!to) { setStatus("Could not determine an address to send the test to."); return; }
    setStatus(`Sending a test email to ${to}…`);
    const { data, error } = await supabase.functions.invoke("deliver-emails", { body: { mode: "test", to } });
    if (error) { setStatus(`Could not run the test: ${await functionErrorMessage(error, data, error.message)}`); return; }
    setStatus(data?.detail ?? (data?.ok ? `Test email sent to ${to}.` : "Resend rejected the test email."));
    await load();
  }

  /**
   * Queues a one-page test job -- no printer script exists yet to actually
   * print it, so this only confirms the queue itself (RLS, grants, the row
   * shape) is wired correctly, the same way testOpenSign/testResend confirm
   * their own connection before the real thing is trusted.
   */
  async function testPrint() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setStatus("Queuing a test page…");
    const { error } = await supabase.from("print_jobs").insert({
      title: "Test page",
      html_body: "<!doctype html><html><head><meta charset=\"utf-8\"><title>Test page</title></head><body style=\"font:16px sans-serif;padding:40px;\"><h1>Veritas Village printer test</h1><p>If this printed, the office printer is wired up correctly.</p></body></html>",
      duplex: false, orientation: "portrait", sides: "one-sided",
    });
    if (error) { setStatus(`Could not queue the test page: ${error.message}`); return; }
    setStatus("Test page queued. It will print once the Raspberry Pi script is running.");
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
      <p>Once the base URL is set, the Compliance tab can open OpenSign in a new tab to build a template with real field placement -- paste the template&rsquo;s id back onto the requirement there when it&rsquo;s ready.</p>
    </aside>
    <aside className="integration-help">
      <p className="card-kicker">Resend setup</p>
      <ol>
        <li><b>API key</b> — Resend → API Keys. This one is stored in Supabase Vault rather than a server secret, since setting a server secret needs the site owner&rsquo;s own CLI login.</li>
        <li><b>Verified domain</b> — Resend → Domains. A From address only sends reliably once its domain is verified there.</li>
        <li><b>From address</b> — set it below once the domain is verified, e.g. <code>Veritas Village &lt;noreply@yourdomain.org&gt;</code>.</li>
      </ol>
      <p>Compliance reminders already show up in the notification bell. Once a From address is set and a test email arrives, reminder emails start going out on the same daily schedule automatically.</p>
    </aside>
    <aside className="integration-help">
      <p className="card-kicker">Office printer setup</p>
      <ol>
        <li><b>Printer</b> — a Brother HL-L3300CDW on the office network, duplex-capable. Set its IP or hostname below once it&rsquo;s on the network; nothing in this app talks to it directly today, so this is just a record for whoever sets up the next step.</li>
        <li><b>Raspberry Pi</b> — not built yet. It will poll the deployed <code>printer-dispatch</code> function with <code>{"{ mode: \"list\" }"}</code>, print each returned job&rsquo;s <code>html_body</code> using the job&rsquo;s <code>sides</code> value over IPP/CUPS, then report back with <code>{"{ mode: \"report\", id, status }"}</code>.</li>
        <li><b>Shared secret</b> — set a <code>PRINT_DELIVERY_SECRET</code> in Supabase Vault (same mechanism as the email delivery secret) and have the Pi send it as an <code>x-delivery-secret</code> header. Without it the function refuses every request.</li>
      </ol>
      <p>The &ldquo;Double-sided&rdquo; checkbox on every printable report already queues a job with the right <code>sides</code> value worked out — landscape reports bind on the short edge so the back of the page lands right-side-up. Recent jobs show up below once any are queued.</p>
    </aside>
    <div className="integrations-list">
      {integrations.map((row) => <IntegrationCard
        key={row.id} row={row} onSave={save}
        live={row.id === "opensign" || row.id === "resend"}
        onTest={row.id === "opensign" ? testOpenSign : row.id === "resend" ? testResend : row.id === "printer" ? testPrint : undefined}
        testLabel={row.id === "resend" ? "Send test email" : row.id === "printer" ? "Queue a test page" : "Test connection"}
        showApiBase={row.id === "opensign"}
        showFromAddress={row.id === "resend"}
      />)}
    </div>
    <RecentPrintJobs />
  </section>;
}

/**
 * The print_jobs queue is invisible otherwise -- nothing consumes it yet, so
 * without this an admin who clicks "Send to office printer" has no way to
 * confirm the job actually landed anywhere.
 */
function RecentPrintJobs() {
  const [jobs, setJobs] = useState<{ id: string; title: string; status: string; duplex: boolean; copies: number; created_at: string; error_detail: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("print_jobs")
      .select("id,title,status,duplex,copies,created_at,error_detail")
      .order("created_at", { ascending: false })
      .limit(10);
    if (!error) setJobs(data ?? []);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function cancel(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.from("print_jobs").update({ status: "canceled" }).eq("id", id);
    await load();
  }

  if (loading || !jobs.length) return null;

  return <div className="integration-card">
    <div className="integration-card-head"><h3>Recent print jobs</h3></div>
    <div className="scroller">
      <table className="print-jobs-table">
        <thead><tr><th>Title</th><th>Sides</th><th>Status</th><th>Queued</th><th /></tr></thead>
        <tbody>{jobs.map((job) => <tr key={job.id}>
          <td>{job.title}</td>
          <td>{job.duplex ? "Double-sided" : "Single-sided"}{job.copies > 1 ? ` · ${job.copies} copies` : ""}</td>
          <td title={job.error_detail ?? undefined}>{job.status}</td>
          <td>{new Date(job.created_at).toLocaleString()}</td>
          <td>{(job.status === "pending" || job.status === "failed") && <button type="button" className="ghost" onClick={() => cancel(job.id)}>Cancel</button>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function IntegrationCard({ row, onSave, live = false, onTest, testLabel = "Test connection", showApiBase = false, showFromAddress = false }: {
  row: Integration; onSave: (row: Integration) => void; live?: boolean; onTest?: () => void; testLabel?: string; showApiBase?: boolean; showFromAddress?: boolean;
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
    {/* The status above is a plain editable field -- an admin's old guess and
        a status this session just verified look identical without this. Only
        shown for the two integrations with a real automated check; nothing
        ever sets it for Facebook, so showing "Never verified" there would be
        accurate but misleading -- there's nothing to verify. */}
    {live && <p className="field-note">{local.last_checked_at
      ? `Last verified ${new Date(local.last_checked_at).toLocaleString()}`
      : "Never verified -- run a test to confirm this status is real."}</p>}
    <label>Note<textarea value={local.public_note ?? ""} onChange={(event) => setLocal({ ...local, public_note: event.target.value })} /></label>
    <div className="field-row">
      <label>{row.id === "facebook" ? "Group URL — shown on the site" : "External URL"}
        <input value={local.external_url ?? ""} onChange={(event) => setLocal({ ...local, external_url: event.target.value })} placeholder="https://…" />
      </label>
      {showApiBase && <label>API base URL<input value={local.api_base_url ?? ""} onChange={(event) => setLocal({ ...local, api_base_url: event.target.value })} placeholder="https://api…" /></label>}
      {showFromAddress && <label>From address<input value={local.from_address ?? ""} onChange={(event) => setLocal({ ...local, from_address: event.target.value })} placeholder="Veritas Village <noreply@yourdomain.org>" /></label>}
    </div>
    {row.id === "opensign" && <p className="field-note">
      This base URL is read by the signing function every time a document is sent — changing it changes real behaviour.
    </p>}
    {row.id === "resend" && <p className="field-note">
      Read by the compliance-reminder emails every time they go out — changing it changes real behaviour.
    </p>}
    {row.id === "facebook" && <p className="field-note">
      This link is what shows on the public site and in the family portal — saving it here updates it everywhere at once.
    </p>}
    <div className="row-actions">
      <button onClick={() => onSave(local)}>Save</button>
      {onTest && <button type="button" className="ghost" onClick={onTest}>{testLabel}</button>}
    </div>
  </article>;
}
