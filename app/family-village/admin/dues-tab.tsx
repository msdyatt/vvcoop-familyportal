"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";
import { downloadReceipt } from "../../../lib/dues-api";
import { downloadCsv, toCsv } from "../../../lib/csv";
import {
  CHARGE_COLUMNS, PAYMENT_COLUMNS, formatCents, formatDueDate, formatWhen, methodLabel, paymentStatusLabel, parseDollars,
  type BillingProvider, type BillingSettings, type DuesCharge, type Payment, type RequirementOptions,
} from "../../../lib/dues";

type Section = "ledger" | "payments" | "approvals" | "settings";
type Approval = { id: string; action: string; target_id: string | null; amount_cents: number | null; requested_by: string | null; request_note: string | null; status: string; approved_by: string | null; expires_at: string; created_at: string };
type Requirement = { id: string; title: string; amount_per_family: number | null; amount_per_child: number | null; due_on: string | null; school_year_id: string };
type DiscountType = { id: string; label: string; kind: string; value: number };
type PaymentRow = Payment & { families: { display_name: string } | null };

const MODE_LABEL: Record<BillingProvider, string> = { off: "Off", stripe_test: "Test mode", stripe_live: "Live" };

export default function DuesTab({ actorUserId }: { actorUserId: string }) {
  const [section, setSection] = useState<Section>("ledger");
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [charges, setCharges] = useState<DuesCharge[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [options, setOptions] = useState<RequirementOptions[]>([]);
  const [discountTypes, setDiscountTypes] = useState<DiscountType[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [years, setYears] = useState<{ id: string; label: string; is_current: boolean }[]>([]);
  const [yearId, setYearId] = useState("");

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: yearRows } = await supabase.from("school_years").select("id,label,is_current").order("label", { ascending: false });
    setYears((yearRows ?? []) as { id: string; label: string; is_current: boolean }[]);
    setYearId((chosen) => chosen || (yearRows ?? []).find((y) => y.is_current)?.id || (yearRows ?? [])[0]?.id || "");
    const [s, c, p, a, r, o, d] = await Promise.all([
      supabase.from("billing_settings").select("provider,reminder_days_before,retry_after_days,max_attempts,receipt_org_name,receipt_ein,receipt_address,receipt_note").eq("id", "dues").maybeSingle(),
      supabase.from("dues_ledger").select(CHARGE_COLUMNS).order("family_name"),
      supabase.from("dues_payments").select(`${PAYMENT_COLUMNS},families(display_name)`).order("created_at", { ascending: false }).limit(300),
      supabase.from("billing_approvals").select("id,action,target_id,amount_cents,requested_by,request_note,status,approved_by,expires_at,created_at").order("created_at", { ascending: false }).limit(30),
      supabase.from("requirements").select("id,title,amount_per_family,amount_per_child,due_on,school_year_id").eq("kind", "dues").eq("active", true),
      supabase.from("dues_requirement_options").select("requirement_id,monthly_enabled,monthly_count,monthly_first_due_on"),
      supabase.from("dues_discount_types").select("id,label,kind,value").eq("active", true),
    ]);
    setSettings((s.data as BillingSettings | null) ?? null);
    setCharges((c.data ?? []) as unknown as DuesCharge[]);
    setPayments((p.data ?? []) as unknown as PaymentRow[]);
    setApprovals((a.data ?? []) as Approval[]);
    setRequirements((r.data ?? []) as Requirement[]);
    setOptions((o.data ?? []) as RequirementOptions[]);
    setDiscountTypes((d.data ?? []) as DiscountType[]);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
  useEffect(() => { void load(); }, [load]);

  /** Runs a database function and reports the outcome in plain words. */
  async function run(fn: string, args: Record<string, unknown>, done: string): Promise<boolean> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return false;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) { setMessage(error.message); return false; }
    setMessage(done);
    await load();
    return true;
  }

  async function callAdmin(body: Record<string, unknown>, done: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return null;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.functions.invoke("dues-admin", { body });
    setBusy(false);
    if (error || data?.error) { setMessage(await functionErrorMessage(error, data, "That did not work.")); return null; }
    setMessage(done);
    await load();
    return data;
  }

  const provider = settings?.provider ?? "off";
  return <div className="dues-admin">
    <header className="dues-admin-head">
      <div><p className="card-kicker">Money</p><h2>Dues</h2></div>
      <span className={`status-pill ${provider === "stripe_live" ? "complete" : provider === "stripe_test" ? "pending" : "waived"}`}>{MODE_LABEL[provider]}</span>
    </header>
    <nav className="dues-admin-nav" aria-label="Dues sections">
      {(["ledger", "payments", "approvals", "settings"] as Section[]).map((key) =>
        <button key={key} type="button" className={section === key ? "active" : ""} onClick={() => setSection(key)}>{{ ledger: "Ledger", payments: "Payments", approvals: "Approvals", settings: "Settings" }[key]}</button>)}
    </nav>
    {message && <p className="dues-flash" role="status">{message}</p>}
    {section === "ledger" && <label className="dues-year"><span className="field-caption">School year</span>
      <select value={yearId} onChange={(e) => setYearId(e.target.value)}>
        {years.map((y) => <option key={y.id} value={y.id}>{y.label}{y.is_current ? " (current)" : ""}</option>)}
        {!years.length && <option value="">No school years yet</option>}
      </select></label>}
    {section === "ledger" && <Ledger charges={charges.filter((c) => !yearId || c.school_year_id === yearId)} requirements={requirements.filter((r) => !yearId || r.school_year_id === yearId)} options={options} discountTypes={discountTypes} busy={busy} run={run} />}
    {section === "payments" && <Payments payments={payments} provider={provider} approvals={approvals} busy={busy} run={run} callAdmin={callAdmin} onMessage={setMessage} />}
    {section === "approvals" && <Approvals approvals={approvals} actorUserId={actorUserId} busy={busy} run={run} />}
    {section === "settings" && <Settings settings={settings} approvals={approvals} actorUserId={actorUserId} busy={busy} run={run} callAdmin={callAdmin} />}
  </div>;
}

type Run = (fn: string, args: Record<string, unknown>, done: string) => Promise<boolean>;

function Ledger({ charges, requirements, options, discountTypes, busy, run }: { charges: DuesCharge[]; requirements: Requirement[]; options: RequirementOptions[]; discountTypes: DiscountType[]; busy: boolean; run: Run }) {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = useMemo(() => charges.filter((c) =>
    (status === "all" || (status === "owing" ? c.balance_cents > 0 && c.status !== "void" : c.status === status)) &&
    (!search.trim() || c.family_name.toLowerCase().includes(search.trim().toLowerCase()))), [charges, status, search]);
  const totals = useMemo(() => charges.filter((c) => c.status !== "void").reduce((t, c) => ({
    due: t.due + c.amount_due_cents, paid: t.paid + c.amount_paid_cents - c.amount_refunded_cents, owing: t.owing + Math.max(c.balance_cents, 0),
  }), { due: 0, paid: 0, owing: 0 }), [charges]);

  function exportCsv() {
    downloadCsv("dues-ledger.csv", toCsv([
      ["Family", "Dues", "Base", "Discounts", "Adjustments", "Paid", "Refunded", "Balance", "Status"],
      ...shown.map((c) => [c.family_name, c.requirement_title, c.subtotal_cents / 100, c.discount_total_cents / 100, c.adjustment_total_cents / 100, c.amount_paid_cents / 100, c.amount_refunded_cents / 100, c.balance_cents / 100, c.status]),
    ]));
  }

  return <>
    <SetUp requirements={requirements} options={options} busy={busy} run={run} />
    <dl className="dues-totals">
      <div><dt>Billed</dt><dd>{formatCents(totals.due)}</dd></div>
      <div><dt>Collected (net of refunds)</dt><dd>{formatCents(totals.paid)}</dd></div>
      <div><dt>Still owed</dt><dd>{formatCents(totals.owing)}</dd></div>
    </dl>
    <div className="compliance-toolbar">
      <label>Show<select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="all">All</option><option value="owing">Owing a balance</option><option value="partially_paid">Partly paid</option><option value="paid">Paid</option><option value="void">Waived</option></select></label>
      <label>Family<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" /></label>
      <button type="button" className="ghost" onClick={exportCsv}>Export CSV</button>
    </div>
    {!shown.length && <p className="portal-empty">No charges match. Open dues for a year above to create them.</p>}
    <ul className="dues-ledger">
      {shown.map((c) => <li key={c.id}>
        <button type="button" className="dues-ledger-row" aria-expanded={openId === c.id} onClick={() => setOpenId(openId === c.id ? null : c.id)}>
          <b>{c.family_name}</b><span>{c.requirement_title}</span><span>{formatCents(c.amount_due_cents)}</span><span>paid {formatCents(c.amount_paid_cents - c.amount_refunded_cents)}</span>
          <span className={`status-pill ${c.status === "paid" ? "complete" : c.status === "void" ? "waived" : c.status === "partially_paid" ? "pending" : "outstanding"}`}>{c.status === "void" ? "Waived" : c.balance_cents > 0 ? formatCents(c.balance_cents) : "Paid"}</span>
        </button>
        {openId === c.id && <ChargeTools charge={c} discountTypes={discountTypes} busy={busy} run={run} />}
      </li>)}
    </ul>
  </>;
}

function SetUp({ requirements, options, busy, run }: { requirements: Requirement[]; options: RequirementOptions[]; busy: boolean; run: Run }) {
  const [title, setTitle] = useState("Annual dues"); const [perFamily, setPerFamily] = useState("300"); const [perChild, setPerChild] = useState("150"); const [dueOn, setDueOn] = useState("");
  const [creating, setCreating] = useState(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient(); if (!supabase) return;
    const family = parseDollars(perFamily), child = parseDollars(perChild);
    if (family === null || child === null) return;
    const { data: year } = await supabase.from("school_years").select("id").eq("is_current", true).maybeSingle();
    if (!year) { alert("Set a current school year first."); return; }
    setCreating(true);
    await supabase.from("requirements").insert({ school_year_id: year.id, kind: "dues", title: title.trim(), amount_per_family: family / 100, amount_per_child: child / 100, due_on: dueOn || null });
    setCreating(false);
    await run("admin_open_dues", {}, "").catch(() => undefined);
    location.reload();
  }
  return <section className="dues-setup">
    <h3>Dues for the year</h3>
    {requirements.map((r) => {
      const o = options.find((x) => x.requirement_id === r.id);
      return <div key={r.id} className="dues-setup-row">
        <div><b>{r.title}</b><span>{formatCents(Math.round(Number(r.amount_per_family ?? 0) * 100))} per family + {formatCents(Math.round(Number(r.amount_per_child ?? 0) * 100))} per child{r.due_on ? ` · due ${formatDueDate(r.due_on)}` : ""}</span></div>
        <button type="button" className="compliance-cta" disabled={busy} onClick={() => run("admin_open_dues", { p_requirement: r.id }, "Dues opened for every household that did not have a charge yet.")}>Open dues for all families</button>
        <label className="dues-agree"><input type="checkbox" checked={o?.monthly_enabled ?? false} disabled={busy}
          onChange={(e) => run("admin_set_dues_options", { p_requirement: r.id, p_monthly_enabled: e.target.checked, p_monthly_count: o?.monthly_count ?? 9, p_first_due_on: o?.monthly_first_due_on ?? null }, "Saved.")} /> <span>Offer a monthly plan ({o?.monthly_count ?? 9} payments)</span></label>
        {o?.monthly_enabled && <label>Payments<select value={o.monthly_count} disabled={busy} onChange={(e) => run("admin_set_dues_options", { p_requirement: r.id, p_monthly_enabled: true, p_monthly_count: Number(e.target.value), p_first_due_on: o.monthly_first_due_on }, "Saved.")}>
          {[2, 3, 4, 5, 6, 8, 9, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}
      </div>;
    })}
    {!requirements.length && <form className="compliance-form" onSubmit={create}>
      <label>Name<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Per family ($)<input required inputMode="decimal" value={perFamily} onChange={(e) => setPerFamily(e.target.value)} /></label>
      <label>Per child ($)<input required inputMode="decimal" value={perChild} onChange={(e) => setPerChild(e.target.value)} /></label>
      <label>Due date<input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
      <button disabled={creating}>Create dues for this year</button>
    </form>}
  </section>;
}

function ChargeTools({ charge, discountTypes, busy, run }: { charge: DuesCharge; discountTypes: DiscountType[]; busy: boolean; run: Run }) {
  const [adjAmount, setAdjAmount] = useState(""); const [adjReason, setAdjReason] = useState("correction"); const [adjMemo, setAdjMemo] = useState("");
  const [discType, setDiscType] = useState(""); const [discLabel, setDiscLabel] = useState(""); const [discAmount, setDiscAmount] = useState("");
  const [cashAmount, setCashAmount] = useState(""); const [cashMethod, setCashMethod] = useState("check"); const [cashRef, setCashRef] = useState("");
  const [plan, setPlan] = useState([{ due_on: "", amount: "" }, { due_on: "", amount: "" }]);
  const planTotal = plan.reduce((t, row) => t + (parseDollars(row.amount) ?? 0), 0);

  return <div className="dues-tools">
    <p className="dues-note">Balance {formatCents(charge.balance_cents)} · base {formatCents(charge.subtotal_cents)} · discounts −{formatCents(charge.discount_total_cents)} · adjustments {formatCents(charge.adjustment_total_cents)}. Notes you write here are shown to the family.</p>
    <div className="dues-tools-grid">
      <form onSubmit={(e) => { e.preventDefault(); const cents = parseDollars(adjAmount.replace(/^-/, "")); if (cents === null) return; void run("admin_add_adjustment", { p_charge: charge.id, p_amount_cents: adjAmount.startsWith("-") ? -cents : cents, p_reason: adjReason, p_memo: adjMemo }, "Adjustment added.").then((ok) => { if (ok) { setAdjAmount(""); setAdjMemo(""); } }); }}>
        <h4>Adjustment</h4>
        <label>Amount ($, negative for a credit)<input required value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} placeholder="-50.00" /></label>
        <label>Reason<select value={adjReason} onChange={(e) => setAdjReason(e.target.value)}><option value="correction">Correction</option><option value="late_fee">Late fee</option><option value="goodwill_credit">Goodwill credit</option><option value="hardship">Hardship</option><option value="other">Other</option></select></label>
        <label>Note for the family<input required maxLength={300} value={adjMemo} onChange={(e) => setAdjMemo(e.target.value)} /></label>
        <button disabled={busy}>Add adjustment</button>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); void run("admin_apply_discount", { p_charge: charge.id, p_type: discType || null, p_label: discLabel, p_amount_cents: discType ? null : parseDollars(discAmount) }, "Discount applied."); }}>
        <h4>Discount</h4>
        <label>Kind<select value={discType} onChange={(e) => setDiscType(e.target.value)}><option value="">One-off</option>{discountTypes.map((t) => <option key={t.id} value={t.id}>{t.label} ({t.kind === "percent" ? `${t.value / 100}%` : formatCents(t.value)})</option>)}</select></label>
        {!discType && <><label>Label for the family<input required value={discLabel} onChange={(e) => setDiscLabel(e.target.value)} /></label><label>Amount ($)<input required value={discAmount} onChange={(e) => setDiscAmount(e.target.value)} /></label></>}
        <button disabled={busy}>Apply discount</button>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); const cents = parseDollars(cashAmount); if (cents === null) return; void run("admin_record_offline_payment", { p_charge: charge.id, p_amount_cents: cents, p_method: cashMethod, p_reference: cashRef, p_received_on: null, p_note: null }, "Payment recorded.").then((ok) => { if (ok) { setCashAmount(""); setCashRef(""); } }); }}>
        <h4>Record cash or check</h4>
        <label>Amount ($)<input required value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} /></label>
        <label>Method<select value={cashMethod} onChange={(e) => setCashMethod(e.target.value)}><option value="check">Check</option><option value="cash">Cash</option><option value="crowded">Crowded</option><option value="other">Other</option></select></label>
        <label>Check number or note<input value={cashRef} onChange={(e) => setCashRef(e.target.value)} /></label>
        <button disabled={busy}>Record payment</button>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); const items = plan.map((row) => ({ due_on: row.due_on, amount_cents: parseDollars(row.amount) })); if (items.some((i) => !i.due_on || !i.amount_cents)) return; void run("admin_set_plan", { p_charge: charge.id, p_installments: items }, "Plan saved."); }}>
        <h4>Custom plan</h4>
        {plan.map((row, i) => <div key={i} className="dues-plan-row">
          <input type="date" required aria-label={`Installment ${i + 1} date`} value={row.due_on} onChange={(e) => setPlan(plan.map((r, j) => j === i ? { ...r, due_on: e.target.value } : r))} />
          <input required aria-label={`Installment ${i + 1} amount`} placeholder="$" value={row.amount} onChange={(e) => setPlan(plan.map((r, j) => j === i ? { ...r, amount: e.target.value } : r))} />
        </div>)}
        <p className="dues-note">Adds up to {formatCents(planTotal)} of {formatCents(charge.balance_cents)} still owed.</p>
        <button type="button" className="link" onClick={() => setPlan([...plan, { due_on: "", amount: "" }])}>Add an installment</button>
        <button disabled={busy || planTotal !== charge.balance_cents}>Save plan</button>
        <button type="button" className="link" disabled={busy} onClick={() => run("admin_clear_plan", { p_charge: charge.id }, "Plan removed.")}>Remove the plan</button>
      </form>
    </div>
    <div className="dues-actions">
      <button type="button" className="ghost" disabled={busy} onClick={() => run("admin_recalculate_charge", { p_charge: charge.id }, "Recalculated from the household's current children.")}>Recalculate base from current children</button>
      {charge.status === "void"
        ? <button type="button" className="ghost" disabled={busy} onClick={() => run("admin_set_charge_void", { p_charge: charge.id, p_void: false, p_reason: null }, "Charge reopened.")}>Reopen</button>
        : <button type="button" className="ghost danger" disabled={busy} onClick={() => { const why = prompt("Why is this household not required to pay? The family will see this."); if (why) void run("admin_set_charge_void", { p_charge: charge.id, p_void: true, p_reason: why }, "Charge waived."); }}>Waive this charge</button>}
    </div>
  </div>;
}

function Payments({ payments, provider, approvals, busy, run, callAdmin, onMessage }: { payments: PaymentRow[]; provider: BillingProvider; approvals: Approval[]; busy: boolean; run: Run; callAdmin: (b: Record<string, unknown>, d: string) => Promise<unknown>; onMessage: (m: string) => void }) {
  async function refund(p: PaymentRow) {
    const text = prompt(`Refund how much of ${formatCents(p.amount_cents)}? (dollars)`, (p.amount_cents / 100).toFixed(2)); if (!text) return;
    const cents = parseDollars(text); if (cents === null) return;
    const reason = prompt("Reason (kept in the record):"); if (!reason) return;
    const reduce = confirm("Also reduce what the family owes by this amount?\n\nOK = yes (usual for a withdrawal or overpayment).\nCancel = no, they still owe it.");
    const approval = p.livemode ? approvals.find((a) => a.action === (p.method === "card" || p.method === "us_bank_account" ? "refund" : "offline_refund") && a.target_id === p.id && a.status === "approved")?.id : undefined;
    if (p.method === "card" || p.method === "us_bank_account") await callAdmin({ action: "refund", paymentId: p.id, amountCents: cents, reason, reduceOwed: reduce, approvalId: approval }, "Refund requested. It is recorded once Stripe confirms.");
    else await run("admin_record_offline_refund", { p_payment: p.id, p_amount_cents: cents, p_reason: reason, p_reduce_owed: reduce, p_approval: approval ?? null }, "Refund recorded.");
  }
  async function receipt(id: string) { const s = getSupabaseBrowserClient(); if (s) { const f = await downloadReceipt(s, id); if (f) onMessage(f); } }
  function exportCsv() {
    downloadCsv("dues-payments.csv", toCsv([["Date", "Family", "Direction", "Amount", "Method", "Status", "Source", "Test"],
      ...payments.map((p) => [p.occurred_at ?? p.created_at, p.families?.display_name ?? "", p.direction, p.amount_cents / 100, methodLabel(p), p.status, p.source, p.livemode ? "" : "test"])]));
  }
  return <>
    <div className="compliance-toolbar">
      {provider !== "off" && <button type="button" className="ghost" disabled={busy} onClick={() => callAdmin({ action: "sync" }, "Checked Stripe for pending payments.")}>Check Stripe for pending payments</button>}
      {provider !== "off" && <button type="button" className="ghost" disabled={busy} onClick={async () => { const r = await callAdmin({ action: "reconcile" }, "") as { checked: number; mismatches: unknown[] } | null; if (r) onMessage(r.mismatches.length ? `${r.mismatches.length} of ${r.checked} settled payments disagree with Stripe: ${JSON.stringify(r.mismatches)}` : `All ${r.checked} recent settled payments match Stripe.`); }}>Reconcile with Stripe</button>}
      <button type="button" className="ghost" onClick={exportCsv}>Export CSV</button>
    </div>
    <div className="dues-history"><table>
      <thead><tr><th scope="col">Date</th><th scope="col">Family</th><th scope="col">Amount</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody>{payments.map((p) => { const st = paymentStatusLabel(p); return <tr key={p.id}>
        <td data-label="Date">{formatWhen(p.occurred_at ?? p.created_at)}</td>
        <td data-label="Family">{p.families?.display_name}</td>
        <td data-label="Amount">{p.direction === "refund" ? "−" : ""}{formatCents(p.amount_cents)}</td>
        <td data-label="Method">{methodLabel(p)}{p.livemode ? "" : " · test"}<small>{p.source.replace("_", " ")}</small></td>
        <td data-label="Status"><span className={`status-pill ${st.tone}`}>{st.text}</span>{p.failure_message && <small>{p.failure_message}</small>}</td>
        <td>{p.status === "succeeded" && <button type="button" className="link" onClick={() => receipt(p.id)}>Receipt</button>}
          {p.direction === "charge" && p.status === "succeeded" && <> <button type="button" className="link" disabled={busy} onClick={() => refund(p)}>Refund</button></>}
          {p.direction === "charge" && p.status === "pending" && <> <button type="button" className="link" disabled={busy} onClick={() => callAdmin({ action: "cancel", paymentId: p.id }, "Canceled.")}>Cancel</button></>}</td>
      </tr>; })}</tbody>
    </table>{!payments.length && <p className="portal-empty">No payments yet.</p>}</div>
  </>;
}

function Approvals({ approvals, actorUserId, busy, run }: { approvals: Approval[]; actorUserId: string; busy: boolean; run: Run }) {
  const [now] = useState(() => Date.now());
  return <>
    <p className="dues-note">Live billing actions need a second administrator. A request lasts 30 minutes and can be used once. Test mode never needs one.</p>
    <ul className="dues-ledger">
      {approvals.map((a) => { const mine = a.requested_by === actorUserId; const expired = new Date(a.expires_at).getTime() < now;
        return <li key={a.id} className="dues-approval"><b>{a.action.replace("_", " ")}</b><span>{a.request_note}{a.amount_cents ? ` · ${formatCents(a.amount_cents)}` : ""}</span><span className="status-pill pending">{expired && a.status === "pending" ? "expired" : a.status}</span>
          {a.status === "pending" && !expired && !mine && <><button type="button" className="compliance-cta" disabled={busy} onClick={() => run("admin_decide_approval", { p_approval: a.id, p_approve: true, p_note: null }, "Approved.")}>Approve</button><button type="button" className="ghost" disabled={busy} onClick={() => run("admin_decide_approval", { p_approval: a.id, p_approve: false, p_note: null }, "Rejected.")}>Reject</button></>}
          {a.status === "pending" && mine && <small>Waiting for another administrator</small>}</li>; })}
    </ul>{!approvals.length && <p className="portal-empty">No requests.</p>}
  </>;
}

function Settings({ settings, approvals, actorUserId, busy, run, callAdmin }: { settings: BillingSettings | null; approvals: Approval[]; actorUserId: string; busy: boolean; run: Run; callAdmin: (b: Record<string, unknown>, d: string) => Promise<unknown> }) {
  const [status, setStatus] = useState<string>("");
  const [form, setForm] = useState(() => ({ reminder: settings?.reminder_days_before ?? 3, retry: settings?.retry_after_days ?? 3, attempts: settings?.max_attempts ?? 3, name: settings?.receipt_org_name ?? "Veritas Village", ein: settings?.receipt_ein ?? "", address: settings?.receipt_address ?? "", note: settings?.receipt_note ?? "" }));
  const provider = settings?.provider ?? "off";
  const goLive = approvals.find((a) => a.action === "enable_livemode" && a.status === "approved" && a.approved_by !== actorUserId && new Date(a.expires_at) > new Date());

  async function check() {
    const data = await callAdmin({ action: "status" }, "") as { provider: string; keyConfigured: boolean; problem: string | null; webhookSecretConfigured: boolean; account?: { name: string | null; id: string; chargesEnabled: boolean } } | null;
    if (!data) return;
    setStatus(data.problem ? data.problem : `Connected to ${data.account?.name ?? data.account?.id} (${data.provider === "stripe_live" ? "live" : "test"} key). ${data.webhookSecretConfigured ? "Webhook secret is set." : "The webhook secret is NOT set yet, so payments will never be marked paid."}`);
  }
  return <div className="dues-settings">
    <section><h3>Mode</h3>
      <p className="dues-note">Off: families see the old payment link. Test: practice payments with Stripe test cards. Live: real money.</p>
      <div className="dues-actions">
        <button type="button" className="ghost" disabled={busy} onClick={check}>Check Stripe connection</button>
        <select aria-label="Mode" value={provider} disabled={busy} onChange={(e) => { if (e.target.value !== "stripe_live") void run("admin_set_billing_provider", { p_provider: e.target.value }, "Mode changed."); }}>
          <option value="off">Off</option><option value="stripe_test">Test mode</option>{provider === "stripe_live" && <option value="stripe_live">Live</option>}</select>
      </div>
      {status && <p className="dues-flash" role="status">{status}</p>}
      {provider !== "stripe_live" && <div className="dues-golive"><h4>Going live</h4>
        <p className="dues-note">One administrator requests, a different one approves in Approvals, then the first switches the mode. Do the checklist in docs/stripe-setup-checklist.md first, and clear test data.</p>
        <div className="dues-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => { const note = prompt("Why go live now?"); if (note) void run("admin_request_approval", { p_action: "enable_livemode", p_target_type: null, p_target_id: null, p_amount_cents: 0, p_note: note }, "Requested. Another administrator can approve it in Approvals."); }}>Request to go live</button>
          <button type="button" className="compliance-cta" disabled={busy || !goLive} onClick={() => run("admin_set_billing_provider", { p_provider: "stripe_live", p_approval: goLive?.id }, "Live mode is on.")}>Switch to live (needs an approved request)</button>
          <button type="button" className="ghost danger" disabled={busy} onClick={() => { if (confirm("Delete all test-mode payments, customers and events? Real records are untouched.")) void run("admin_purge_test_billing_data", {}, "Test data cleared."); }}>Clear test data</button>
        </div></div>}
    </section>
    <form onSubmit={(e) => { e.preventDefault(); void run("admin_update_billing_settings", { p_reminder_days: form.reminder, p_retry_after_days: form.retry, p_max_attempts: form.attempts, p_org_name: form.name, p_ein: form.ein, p_address: form.address, p_note: form.note }, "Settings saved."); }}>
      <h3>Reminders and retries</h3>
      <label>Remind families this many days before an installment<input type="number" min={0} max={14} value={form.reminder} onChange={(e) => setForm({ ...form, reminder: Number(e.target.value) })} /></label>
      <label>Wait this many days before retrying a failed automatic payment<input type="number" min={1} max={14} value={form.retry} onChange={(e) => setForm({ ...form, retry: Number(e.target.value) })} /></label>
      <label>Stop after this many failed attempts<input type="number" min={1} max={6} value={form.attempts} onChange={(e) => setForm({ ...form, attempts: Number(e.target.value) })} /></label>
      <h3>Receipts</h3>
      <label>Organization name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>EIN<input value={form.ein} onChange={(e) => setForm({ ...form, ein: e.target.value })} /></label>
      <label>Address<textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
      <label>Wording at the bottom (ask your CPA before saying anything about tax deductibility)<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <button disabled={busy}>Save</button>
    </form>
  </div>;
}
