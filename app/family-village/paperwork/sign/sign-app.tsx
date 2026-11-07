"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../../lib/supabase";
import { getSignedFileUrl, PRIVATE_BUCKET } from "../../../../lib/storage";
import { usePortalAccess } from "../../../../lib/use-portal-access";
import {
  FIELD_COLUMNS, REQUEST_COLUMNS, SIGNER_COLUMNS, blockerSentences, formatSignedAt, friendlyError, getEligibility,
  requestSeal, requestStatusLabel, signerStatusLabel, statusTone,
  type Mark, type SignField, type SignRequest, type SignSigner, type SignValue,
} from "../../../../lib/sign";
import AppHeader from "../../app-header";
import MfaChallengeScreen from "../../mfa-challenge";
import PdfPages from "../../pdf-pages";
import SignatureDialog from "./signature-dialog";

const todayCentral = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

type Loaded = {
  request: SignRequest;
  signers: SignSigner[];
  fields: SignField[];
  values: SignValue[];
};

export default function SignApp() {
  const { state: access, userId, roles, recheck } = usePortalAccess("member");
  // The page is static, so the request id is read from the address on the client.
  const [requestId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("request"));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState("");
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [eligibility, setEligibility] = useState<{ eligible: boolean; blockers: string[] } | null>(null);
  const [consentText, setConsentText] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState<Mark | null>(null);
  const [initials, setInitials] = useState<Mark | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<"signature" | "initials" | null>(null);
  const viewed = useRef(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !requestId) return;
    const { data: request } = await supabase.from("sign_requests").select(REQUEST_COLUMNS).eq("id", requestId).maybeSingle();
    if (!request) { setProblem("We could not find that document. It may have been cancelled, or it was sent to someone else."); return; }
    const r = request as SignRequest;
    const [signers, fields, values] = await Promise.all([
      supabase.from("sign_signers").select(SIGNER_COLUMNS).eq("request_id", requestId).order("slot"),
      supabase.from("sign_fields").select(FIELD_COLUMNS).eq("template_id", r.template_id).order("page"),
      supabase.from("sign_field_values").select("field_id,signer_id,value").eq("request_id", requestId),
    ]);
    setLoaded({
      request: r,
      signers: (signers.data ?? []) as SignSigner[],
      fields: (fields.data ?? []) as SignField[],
      values: (values.data ?? []) as SignValue[],
    });
    const path = r.status === "completed" && r.sealed_path ? r.sealed_path : r.original_path;
    const file = await supabase.storage.from(PRIVATE_BUCKET).download(path);
    if (file.data) setPdf(new Uint8Array(await file.data.arrayBuffer()));
    else setProblem("The document file could not be opened.");
  }, [requestId]);

  useEffect(() => {
    if (access !== "ready" || !requestId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      await load();
      const [e, text] = await Promise.all([getEligibility(supabase), supabase.rpc("sign_consent_text")]);
      if (cancelled) return;
      setEligibility(e);
      setConsentText(typeof text.data === "string" ? text.data : "");
      if (!viewed.current) { viewed.current = true; await supabase.rpc("sign_record_view", { p_request: requestId }); }
    })();
    return () => { cancelled = true; };
  }, [access, requestId, load]);

  // A fully signed request that is still waiting for its sealed copy (the timestamp
  // authority was down, or the last signer closed the tab) is finished by whoever
  // opens it next. Safe to repeat: the database allows one sealing at a time.
  const retried = useRef(false);
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !requestId || retried.current || loaded?.request.status !== "signed") return;
    retried.current = true;
    requestSeal(supabase, requestId).then((result) => { if (result.ok) load(); });
  }, [loaded, requestId, load]);

  const me = loaded?.signers.find((s) => s.user_id === userId) ?? null;
  const myFields = useMemo(() => loaded?.fields.filter((f) => me && f.signer_slot === me.slot) ?? [], [loaded, me]);
  const status = loaded?.request.status;
  const myTurn = !!loaded && !!me && me.status !== "signed" && (status === "sent" || status === "in_progress")
    && !(loaded.request.signing_order === "sequential" && loaded.signers.some((s) => s.slot < me.slot && s.status !== "signed"));
  const waitingFor = loaded && me && me.status !== "signed" && loaded.request.signing_order === "sequential"
    ? loaded.signers.find((s) => s.slot < me.slot && s.status !== "signed") : null;
  const consented = !!me && (me.status === "consented" || !!me.consented_at);
  const canFill = myTurn && eligibility?.eligible === true && consented;

  const done = (f: SignField) => {
    if (f.kind === "signature") return !!signature;
    if (f.kind === "initials") return !!initials;
    if (f.kind === "date") return true;
    if (f.kind === "checkbox") return !f.required || answers[f.id] === "true";
    return !f.required || !!answers[f.id]?.trim();
  };
  const remaining = myFields.filter((f) => !done(f));

  async function giveConsent() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !requestId) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("sign_give_consent", { p_request: requestId });
    setBusy(false);
    if (error) { setMessage(friendlyError(error)); return; }
    await load();
  }

  async function submit() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !requestId) return;
    setBusy(true); setMessage("");
    const values: Record<string, string> = {};
    for (const f of myFields) if ((f.kind === "text" || f.kind === "checkbox") && answers[f.id] !== undefined) values[f.id] = answers[f.id];
    const { data, error } = await supabase.rpc("sign_submit", {
      p_request: requestId, p_signature: signature, p_initials: initials, p_values: values,
    });
    if (error) { setBusy(false); setMessage(friendlyError(error)); await load(); return; }
    const allSigned = (data as { all_signed?: boolean } | null)?.all_signed;
    if (allSigned) {
      const sealed = await requestSeal(supabase, requestId);
      if (!sealed.ok) setMessage("Your signature is saved. The signed copy is still being prepared; an administrator can finish it if it does not appear soon.");
    }
    setBusy(false);
    await load();
  }

  async function downloadSigned() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !requestId || !loaded?.request.sealed_path) return;
    await supabase.rpc("sign_log_download", { p_request: requestId, p_what: "sealed" });
    const url = await getSignedFileUrl(supabase, loaded.request.sealed_path, 300);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  function nextField() {
    const target = remaining[0];
    if (!target) return;
    document.getElementById(`field-${target.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (access === "loading") return <main className="workspace-preview"><p className="portal-empty">Loading…</p></main>;
  if (access === "denied") return <main className="workspace-preview"><p className="portal-empty">Sign in to your Family Village account to sign this document.</p><p><a href="/family-village">Go to sign in</a></p></main>;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={() => { window.location.href = "/family-village"; }} />;

  const nameOf = (slot: number) => loaded?.signers.find((s) => s.slot === slot)?.display_name ?? `Signer ${slot}`;

  function overlay(page: number) {
    if (!loaded) return null;
    return loaded.fields.filter((f) => f.page === page).map((f) => {
      const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
      const signer = loaded.signers.find((s) => s.slot === f.signer_slot);
      const filled = loaded.values.find((v) => v.field_id === f.id);
      const mine = !!me && f.signer_slot === me.slot && status !== "completed";

      // A field for a slot nobody was asked to sign (the household has one adult).
      if (!signer) return null;

      if (!mine) {
        // Someone else's field: show it quietly, or show it signed.
        const text = filled ? (f.kind === "signature" || f.kind === "initials" ? "✓ signed" : f.kind === "checkbox" ? (filled.value === "true" ? "☒" : "☐") : filled.value) : nameOf(f.signer_slot);
        return <div key={f.id} className={`sign-field other${filled ? " filled" : ""}`} style={style} title={`${signer?.display_name ?? ""} · ${f.kind}`}>{status === "completed" ? null : text}</div>;
      }
      if (!canFill) {
        return <div key={f.id} id={`field-${f.id}`} className="sign-field locked" style={style}>{f.kind === "signature" ? "Your signature" : f.kind === "initials" ? "Your initials" : f.label ?? f.kind}</div>;
      }
      if (f.kind === "signature" || f.kind === "initials") {
        const mark = f.kind === "signature" ? signature : initials;
        return <button key={f.id} id={`field-${f.id}`} type="button" className={`sign-field mine ${mark ? "done" : "todo"}`} style={style}
          onClick={() => setDialog(f.kind as "signature" | "initials")} aria-label={f.kind === "signature" ? "Add your signature" : "Add your initials"}>
          {mark ? (mark.kind === "typed"
            ? <span className="sign-typed">{mark.text}</span>
            // eslint-disable-next-line @next/next/no-img-element
            : <img alt="" src={`data:image/png;base64,${mark.png}`} />)
            : <span>{f.kind === "signature" ? "Click to sign" : "Initial here"}</span>}
        </button>;
      }
      if (f.kind === "date") return <div key={f.id} id={`field-${f.id}`} className="sign-field mine done" style={style}><span>{todayCentral()}</span></div>;
      if (f.kind === "checkbox") {
        return <label key={f.id} id={`field-${f.id}`} className={`sign-field mine check ${done(f) ? "done" : "todo"}`} style={style}>
          <input type="checkbox" checked={answers[f.id] === "true"} onChange={(e) => setAnswers((a) => ({ ...a, [f.id]: String(e.target.checked) }))} aria-label={f.label ?? "Checkbox"} />
        </label>;
      }
      return <div key={f.id} id={`field-${f.id}`} className={`sign-field mine text ${done(f) ? "done" : "todo"}`} style={style}>
        <input type="text" value={answers[f.id] ?? ""} maxLength={300} placeholder={f.label ?? "Type here"} aria-label={f.label ?? "Text"}
          onChange={(e) => setAnswers((a) => ({ ...a, [f.id]: e.target.value }))} />
      </div>;
    });
  }

  return <main className="workspace-preview sign-page">
    <AppHeader current="home" roles={roles} title="Sign a document" subtitle="Read it, then sign it here." />
    <p><a className="sign-back" href="/family-village/paperwork">← Back to paperwork</a></p>
    {problem && <p className="portal-empty" role="alert">{problem}</p>}
    {!problem && !loaded && <p className="portal-empty">Loading…</p>}
    {loaded && <div className="sign-layout">
      <aside className="sign-side">
        <h1>{loaded.request.title}</h1>
        <span className={`status-pill ${statusTone(loaded.request.status)}`}>{requestStatusLabel(loaded.request.status)}</span>
        {loaded.request.message && <p className="sign-note">{loaded.request.message}</p>}
        {loaded.request.status === "voided" && <p className="sign-note">This was cancelled{loaded.request.void_reason ? `: ${loaded.request.void_reason}` : "."}</p>}

        <ul className="sign-signers" aria-label="Signers">
          {loaded.signers.map((s) => <li key={s.id}>
            <span><b>{s.display_name}</b>{s.user_id === userId ? " (you)" : ""}</span>
            <span className={`status-pill ${statusTone(s.status)}`}>{signerStatusLabel(s.status)}</span>
            {s.signed_at && <small>{formatSignedAt(s.signed_at)}</small>}
          </li>)}
        </ul>
        {loaded.request.signing_order === "sequential" && <p className="sign-hint">Signing goes in order.</p>}

        {!me && <p className="sign-hint">You can read this document, but you are not one of the people asked to sign it.</p>}

        {status === "completed" && <button type="button" className="sign-big" onClick={downloadSigned}>Download the signed copy</button>}
        {status === "signed" && <p className="sign-hint">Everyone has signed. The signed copy and its certificate are being prepared.{loaded.request.seal_error ? " It has not finished yet; an administrator can try again." : ""}</p>}
        {me?.status === "signed" && status !== "completed" && status !== "voided" && status !== "signed" && <p className="sign-hint">You signed on {formatSignedAt(me.signed_at)}. We are waiting for the other person.</p>}

        {me && me.status !== "signed" && (status === "sent" || status === "in_progress") && <>
          {eligibility && !eligibility.eligible && <div className="sign-callout" role="alert">
            <b>Before you can sign</b>
            <ul>{blockerSentences(eligibility.blockers).map((t) => <li key={t}>{t}</li>)}</ul>
            <small>Open your account menu at the top right, then choose Account &amp; Security.</small>
          </div>}
          {eligibility?.eligible && waitingFor && <p className="sign-hint">{waitingFor.display_name} signs first. You will be asked when it is your turn. You can read the document meanwhile.</p>}
          {eligibility?.eligible && myTurn && !consented && <div className="sign-consent">
            <b>Sign electronically</b>
            <p>{consentText || "Loading…"}</p>
            <label className="checkbox-field"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to sign electronically.</label>
            <button type="button" className="sign-big" disabled={!agree || busy || !consentText} onClick={giveConsent}>Agree and continue</button>
          </div>}
          {canFill && <div className="sign-finish">
            <b>{remaining.length ? `${remaining.length} ${remaining.length === 1 ? "thing" : "things"} left to fill in` : "Everything is filled in"}</b>
            {remaining.length > 0 && <button type="button" className="sign-big secondary compact" onClick={nextField}>Go to next</button>}
            <button type="button" className="sign-big" disabled={remaining.length > 0 || busy} onClick={submit}>{busy ? "Signing…" : "Finish and sign"}</button>
            <small>The date is filled in when you sign. Your name, the time and your device details are recorded.</small>
          </div>}
        </>}
        {message && <p className="sign-note" role="alert">{message}</p>}
      </aside>

      <section className="sign-document" aria-label="Document">
        <PdfPages data={pdf} renderOverlay={overlay} />
      </section>
    </div>}

    {dialog && me && <SignatureDialog
      kind={dialog}
      defaultName={me.display_name}
      onCancel={() => setDialog(null)}
      onAdopt={(mark) => {
        if (dialog === "signature") setSignature(mark); else setInitials(mark);
        setDialog(null);
      }}
    />}
  </main>;
}
