"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import PageSkeleton from "../page-skeleton";
import { usePortalAccess } from "../../../lib/use-portal-access";
import { downloadReceipt, startCheckout, type EmbedInfo } from "../../../lib/dues-api";
import { mountEmbeddedCheckout } from "../../../lib/stripe-embed";
import {
  CHARGE_COLUMNS, PAYMENT_COLUMNS, describeInstallments, formatCents, formatDueDate, formatWhen, methodLabel, monthlyPreview,
  nextPaymentCents, paymentStatusLabel, savedMethodLabel,
  type Adjustment, type BillingSettings, type DiscountLine, type DuesCharge, type Installment, type Payment, type Plan,
  type RequirementOptions, type SavedMethod,
} from "../../../lib/dues";
import AppHeader from "../app-header";
import MfaChallengeScreen from "../mfa-challenge";

type Loaded = {
  settings: BillingSettings | null;
  charges: DuesCharge[];
  yearLabels: Map<string, string>;
  discounts: DiscountLine[];
  adjustments: Adjustment[];
  plans: Plan[];
  installments: Installment[];
  payments: Payment[];
  options: RequirementOptions[];
  saved: SavedMethod | null;
};

async function signOutToEntry() {
  await getSupabaseBrowserClient()?.auth.signOut();
  window.location.assign("/family-village");
}

export default function DuesApp() {
  const { state: access, userId, roles, recheck } = usePortalAccess("member");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [embed, setEmbed] = useState<EmbedInfo | null>(null);
  const [returned] = useState(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("checkout"));

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;
    const { data: members } = await supabase.from("family_members").select("family_id").eq("user_id", userId);
    const familyIds = (members ?? []).map((row) => row.family_id as string);
    if (!familyIds.length) { setData({ settings: null, charges: [], yearLabels: new Map(), discounts: [], adjustments: [], plans: [], installments: [], payments: [], options: [], saved: null }); return; }

    const [settings, charges, years, customers, payments] = await Promise.all([
      supabase.from("billing_settings").select("provider,reminder_days_before,retry_after_days,max_attempts,receipt_org_name,receipt_ein,receipt_address,receipt_note").eq("id", "dues").maybeSingle(),
      supabase.from("dues_ledger").select(CHARGE_COLUMNS).in("family_id", familyIds).order("due_on", { ascending: false, nullsFirst: false }),
      supabase.from("school_years").select("id,label"),
      supabase.from("billing_customers").select("default_pm_type,default_pm_brand,default_pm_last4,default_pm_bank_name,autopay").in("family_id", familyIds),
      supabase.from("dues_payments").select(PAYMENT_COLUMNS).in("family_id", familyIds).order("created_at", { ascending: false }),
    ]);
    if (charges.error) { setError(charges.error.message); return; }
    const chargeRows = (charges.data ?? []) as unknown as DuesCharge[];
    const ids = chargeRows.map((c) => c.id);
    const requirementIds = [...new Set(chargeRows.map((c) => c.requirement_id))];
    const [discounts, adjustments, plans, installments, options] = ids.length ? await Promise.all([
      supabase.from("dues_discount_lines").select("id,charge_id,label,amount_cents").in("charge_id", ids),
      supabase.from("dues_adjustments").select("id,charge_id,amount_cents,reason,memo,reverses_adjustment_id,created_at").in("charge_id", ids).order("created_at"),
      supabase.from("dues_payment_plans").select("id,charge_id,kind,status,paid_before_cents").in("charge_id", ids).in("status", ["active", "completed"]),
      supabase.from("dues_installments").select("id,plan_id,charge_id,seq,due_on,amount_cents,status,paid_at,attempts,needs_attention").in("charge_id", ids).order("seq"),
      supabase.from("dues_requirement_options").select("requirement_id,monthly_enabled,monthly_count,monthly_first_due_on").in("requirement_id", requirementIds),
    ]) : [null, null, null, null, null];

    const savedRows = (customers.data ?? []) as unknown as SavedMethod[];
    setData({
      settings: (settings.data as BillingSettings | null) ?? null,
      charges: chargeRows,
      yearLabels: new Map((years.data ?? []).map((year) => [year.id as string, year.label as string])),
      discounts: (discounts?.data ?? []) as unknown as DiscountLine[],
      adjustments: (adjustments?.data ?? []) as unknown as Adjustment[],
      plans: (plans?.data ?? []) as unknown as Plan[],
      installments: (installments?.data ?? []) as unknown as Installment[],
      payments: (payments.data ?? []) as unknown as Payment[],
      options: (options?.data ?? []) as unknown as RequirementOptions[],
      saved: savedRows.find((row) => row.autopay) ?? savedRows[0] ?? null,
    });
  }, [userId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch once access resolves
  useEffect(() => { if (access === "ready") void load(); }, [access, load]);

  // Coming back from Stripe (or from the system browser in the app): the
  // confirmation arrives by webhook a moment later, so look again a few times.
  useEffect(() => {
    if (access !== "ready") return;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    let attempts = 0;
    const timer = returned === "success" ? setInterval(() => { attempts += 1; void load(); if (attempts >= 6) clearInterval(timer); }, 4000) : undefined;
    return () => { document.removeEventListener("visibilitychange", refresh); if (timer) clearInterval(timer); };
  }, [access, load, returned]);

  // The header and bar stay put while the page fills in; only the content area is a placeholder.
  if (access === "loading") return <main className="workspace-preview dues-page"><AppHeader current="home" roles={roles} title={"Dues"} subtitle={"What you owe, what you have paid, and receipts."} /><PageSkeleton /></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><a href="/family-village">Return to sign in →</a></main>;

  const provider = data?.settings?.provider ?? "off";
  return <main className="workspace-preview dues-page">
    <AppHeader current="home" roles={roles} title="Dues" subtitle="What you owe, what you have paid, and receipts." />
    {provider === "stripe_test" && <p className="dues-test-banner" role="status"><b>Test mode.</b> Payments here are practice only. No real money moves and receipts are marked as tests.</p>}
    {returned === "success" && <p className="dues-flash" role="status">Thank you. Your payment is being confirmed. Card payments show up within a minute; bank transfers take 1–4 business days to clear.</p>}
    {returned === "canceled" && <p className="dues-flash" role="status">You left the payment page before paying, so nothing was charged.</p>}
    {error && <p className="dues-error" role="alert">{error}</p>}
    {!data && !error && <p className="portal-empty">Loading…</p>}
    {data && !data.charges.length && <p className="portal-empty">Nothing is owed right now. When the co-op opens dues for the year, they will appear here.</p>}
    {embed && <EmbeddedPayment info={embed} onClose={() => { setEmbed(null); void load(); }} />}
    {data && data.charges.map((charge) => <ChargeCard key={charge.id} charge={charge} data={data} onChanged={load} onEmbed={setEmbed} />)}
    <p className="dues-footnote">Questions about a charge? Message an administrator from Messages. Your card or bank details are entered on Stripe&rsquo;s secure page and are never stored by the co-op.</p>
  </main>;
}

function ChargeCard({ charge, data, onChanged, onEmbed }: { charge: DuesCharge; data: Loaded; onChanged: () => Promise<void>; onEmbed: (info: EmbedInfo) => void }) {
  const provider = data.settings?.provider ?? "off";
  const plan = data.plans.find((p) => p.charge_id === charge.id && p.status === "active") ?? null;
  const completedPlan = data.plans.find((p) => p.charge_id === charge.id && p.status === "completed") ?? null;
  const installments = data.installments.filter((i) => i.charge_id === charge.id);
  const options = data.options.find((o) => o.requirement_id === charge.requirement_id);
  const payments = data.payments.filter((p) => p.charge_id === charge.id);
  const discounts = data.discounts.filter((d) => d.charge_id === charge.id);
  const adjustments = data.adjustments.filter((a) => a.charge_id === charge.id);
  const inFlight = payments.find((p) => p.direction === "charge" && (p.status === "pending" || p.status === "processing"));
  const lastFailed = payments.find((p) => p.direction === "charge" && p.status === "failed");
  const lastSucceeded = payments.find((p) => p.direction === "charge" && p.status === "succeeded");
  const showFailure = lastFailed && (!lastSucceeded || lastFailed.created_at > lastSucceeded.created_at) && !inFlight && charge.balance_cents > 0;
  const year = data.yearLabels.get(charge.school_year_id);
  const [choice, setChoice] = useState<"full" | "monthly">("full");
  const [autopayAgree, setAutopayAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const settled = charge.status === "paid" || charge.status === "void";
  const monthlyOffered = Boolean(options?.monthly_enabled) && !plan && !completedPlan && charge.balance_cents > 0 && !inFlight && charge.amount_paid_cents === 0;
  const preview = options ? monthlyPreview(charge.balance_cents, options.monthly_count) : null;
  const autopayOn = Boolean(data.saved?.autopay) && plan?.kind === "monthly";
  const views = describeInstallments(installments.filter((i) => plan && i.plan_id === plan.id));
  const nextCents = nextPaymentCents(charge, installments.filter((i) => plan && i.plan_id === plan.id), plan);

  async function pay(kind: "next" | "all") {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    let autopay = false;
    if (!plan && choice === "monthly" && monthlyOffered) {
      const { error } = await supabase.rpc("family_choose_plan", { p_charge: charge.id, p_kind: "monthly" });
      if (error) { setBusy(false); setMessage(error.message); return; }
      autopay = true;
    } else if (plan?.kind === "monthly" && !autopayOn && autopayAgree) {
      autopay = true;
    }
    const result = await startCheckout(supabase, { chargeId: charge.id, payAll: kind === "all" || (!plan && choice === "full"), autopay });
    setBusy(false);
    if (result.error) { setMessage(result.error); void onChanged(); return; }
    if (result.embed) onEmbed(result.embed);
  }

  async function backToFull() {
    if (!confirm("Switch to paying the remaining balance in one payment? Automatic monthly payments will stop.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("family_choose_plan", { p_charge: charge.id, p_kind: "full" });
    if (error) setMessage(error.message);
    else { await supabase.rpc("family_stop_autopay", { p_family: charge.family_id }); await onChanged(); }
    setBusy(false);
  }

  async function stopAutopay() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("family_stop_autopay", { p_family: charge.family_id });
    if (error) setMessage(error.message); else await onChanged();
    setBusy(false);
  }

  async function receipt(paymentId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setMessage("");
    const failure = await downloadReceipt(supabase, paymentId);
    if (failure) setMessage(failure);
  }

  return <section className={`dues-card${settled ? " settled" : ""}`} aria-label={`${charge.requirement_title}${year ? ` ${year}` : ""}`}>
    <header className="dues-card-head">
      <div>
        <p className="card-kicker">{year ?? "Dues"}</p>
        <h2>{charge.requirement_title}</h2>
        {charge.due_on && charge.status !== "paid" && charge.status !== "void" && <p className="dues-due">Due {formatDueDate(charge.due_on)}</p>}
      </div>
      <span className={`status-pill ${charge.status === "paid" ? "complete" : charge.status === "void" ? "waived" : charge.status === "partially_paid" ? "pending" : "outstanding"}`}>
        {charge.status === "paid" ? "Paid in full" : charge.status === "void" ? "Not required" : charge.status === "partially_paid" ? "Partly paid" : "Balance due"}
      </span>
    </header>

    {charge.status === "void" && <p className="dues-note">The co-op has marked this as not required for your household{charge.void_reason ? `: ${charge.void_reason}` : "."}</p>}

    <dl className="dues-breakdown">
      <div><dt>Dues</dt><dd>{formatCents(charge.subtotal_cents)}</dd></div>
      {discounts.map((d) => <div key={d.id}><dt>{d.label}</dt><dd>−{formatCents(d.amount_cents)}</dd></div>)}
      {adjustments.map((a) => <div key={a.id}><dt>{a.memo}</dt><dd>{a.amount_cents < 0 ? "−" : "+"}{formatCents(Math.abs(a.amount_cents))}</dd></div>)}
      <div className="total"><dt>Total for the year</dt><dd>{formatCents(charge.amount_due_cents)}</dd></div>
      <div><dt>Paid</dt><dd>{formatCents(charge.amount_paid_cents)}</dd></div>
      {charge.amount_refunded_cents > 0 && <div><dt>Refunded</dt><dd>−{formatCents(charge.amount_refunded_cents)}</dd></div>}
      <div className="balance"><dt>Balance</dt><dd>{formatCents(Math.max(charge.balance_cents, 0))}</dd></div>
    </dl>

    {views.length > 0 && <div className="dues-schedule">
      <h3>{plan?.kind === "monthly" ? "Your monthly schedule" : "Your payment schedule"}</h3>
      <ol>
        {views.map((i) => <li key={i.id} className={i.display}>
          <span>{formatDueDate(i.due_on)}</span>
          <b>{formatCents(i.amount_cents)}</b>
          <span className={`status-pill ${i.display === "paid" ? "complete" : i.display === "overdue" ? "outstanding" : "pending"}`}>{i.label}</span>
        </li>)}
      </ol>
      {plan?.kind === "custom" && <p className="dues-note">The co-op set this schedule for your household. Contact an administrator to change it.</p>}
      {installments.some((i) => i.needs_attention) && <p className="dues-error" role="alert">An automatic payment failed more than once, so automatic payments are paused. Please pay the next installment below.</p>}
    </div>}

    {autopayOn && <p className="dues-autopay">Automatic payments are on{savedMethodLabel(data.saved) ? `: ${savedMethodLabel(data.saved)}` : ""}. Each installment is collected on its due date.
      {" "}<button type="button" className="link" onClick={stopAutopay} disabled={busy}>Stop automatic payments</button></p>}

    {inFlight?.status === "processing" && <p className="dues-flash" role="status">Payment in progress. Bank transfers take 1–4 business days to clear. You do not need to do anything.</p>}
    {showFailure && <p className="dues-error" role="alert">Your last payment did not go through{lastFailed.failure_message ? `: ${lastFailed.failure_message}` : "."} You can try again below.</p>}

    {monthlyOffered && provider !== "off" && <fieldset className="dues-choice">
      <legend>How would you like to pay?</legend>
      <label><input type="radio" name={`plan-${charge.id}`} checked={choice === "full"} onChange={() => setChoice("full")} /> <span><b>Pay in full</b> {formatCents(charge.balance_cents)} today</span></label>
      <label><input type="radio" name={`plan-${charge.id}`} checked={choice === "monthly"} onChange={() => setChoice("monthly")} /> <span><b>Monthly</b> {options!.monthly_count} payments of {formatCents(preview!.each)}{preview!.last !== preview!.each ? ` (the last is ${formatCents(preview!.last)})` : ""}, the first today</span></label>
      {choice === "monthly" && <p className="dues-note">By choosing monthly payments you authorize Veritas Village to collect each remaining installment automatically from the bank account or card you enter on the next page, on its due date. You can stop automatic payments here at any time.</p>}
    </fieldset>}

    {plan?.kind === "monthly" && !autopayOn && charge.balance_cents > 0 && !inFlight && <label className="dues-agree">
      <input type="checkbox" checked={autopayAgree} onChange={(event) => setAutopayAgree(event.target.checked)} />
      <span>Collect my remaining installments automatically from the method I use today, on their due dates.</span>
    </label>}

    {charge.balance_cents > 0 && charge.status !== "void" && (provider === "off"
      ? <p className="dues-note">Online payment is not open yet. The co-op will tell you when it is.</p>
      : inFlight?.status === "processing"
        ? null
        : <div className="dues-actions">
            <button type="button" className="compliance-cta" disabled={busy} onClick={() => pay(plan ? "next" : "all")}>
              {busy ? "Opening…" : inFlight ? "Continue to payment" : plan ? `Pay ${formatCents(nextCents)} now` : choice === "monthly" && monthlyOffered ? `Start monthly payments · ${formatCents(preview!.each)} today` : `Pay ${formatCents(charge.balance_cents)} now`}
            </button>
            {plan && nextCents < charge.balance_cents && !inFlight && <button type="button" className="compliance-cta ghost" disabled={busy} onClick={() => pay("all")}>Pay the full balance ({formatCents(charge.balance_cents)})</button>}
            {plan?.kind === "monthly" && !inFlight && <button type="button" className="link" disabled={busy} onClick={backToFull}>Pay the rest in one payment instead</button>}
          </div>)}

    {message && <p className="dues-error" role="alert">{message}</p>}

    {payments.length > 0 && <div className="dues-history">
      <h3>Payment history</h3>
      <table>
        <thead><tr><th scope="col">Date</th><th scope="col">Amount</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Receipt</span></th></tr></thead>
        <tbody>
          {payments.map((p) => {
            const status = paymentStatusLabel(p);
            const when = p.occurred_at ?? p.created_at;
            return <tr key={p.id}>
              <td data-label="Date">{formatWhen(when)}</td>
              <td data-label="Amount">{p.direction === "refund" ? "−" : ""}{formatCents(p.amount_cents)}</td>
              <td data-label="Method">{methodLabel(p)}{!p.livemode && p.method !== "cash" && p.method !== "check" ? " · test" : ""}</td>
              <td data-label="Status"><span className={`status-pill ${status.tone}`}>{status.text}</span>{p.status === "failed" && p.failure_message ? <small>{p.failure_message}</small> : null}</td>
              <td>{p.status === "succeeded" && <button type="button" className="compliance-cta ghost" onClick={() => receipt(p.id)}>{p.direction === "refund" ? "Confirmation" : "Receipt"}</button>}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
  </section>;
}

/** Stripe's payment form, inside the page. The details typed here go to Stripe, not to us. */
function EmbeddedPayment({ info, onClose }: { info: EmbedInfo; onClose: () => void }) {
  const target = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      if (!target.current) return;
      try {
        const remove = await mountEmbeddedCheckout(target.current, { clientSecret: info.clientSecret, publishableKey: info.publishableKey, onComplete: () => setDone(true) });
        if (cancelled) remove(); else cleanup = remove;
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : "The payment form could not be loaded.");
      }
    })();
    return () => { cancelled = true; cleanup?.(); };
  }, [info]);

  return <section className="dues-embed" aria-label="Pay dues">
    <header>
      <h2>{done ? "Thank you" : "Pay by bank transfer, card, Apple Pay or Google Pay"}</h2>
      <button type="button" className="compliance-cta ghost" onClick={() => closeRef.current()}>{done ? "Done" : "Cancel"}</button>
    </header>
    {done && <p className="dues-flash" role="status">Your payment was submitted. Card payments show here within a minute; bank transfers take 1–4 business days to clear.</p>}
    {problem && <p className="dues-error" role="alert">{problem}</p>}
    <div ref={target} hidden={done} />
  </section>;
}
