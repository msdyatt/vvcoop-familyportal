"use client";

import { getSupabaseBrowserClient } from "../../lib/supabase";
import { getSignedFileUrl } from "../../lib/storage";
import DuesLink from "./dues-link";
import { SignRequestStatus, SignerStatus, requestStatusLabel } from "../../lib/sign";
import {
  FamilyRequirement, Requirement, formatDate, formatMoney,
  isSettled, outstandingCount, statusLabel, statusTone,
} from "../../lib/compliance";

export type ComplianceItem = { row: FamilyRequirement; requirement: Requirement };

/** The in-portal signing request behind a required document, with who has signed. */
export type SigningInfo = { id: string; status: SignRequestStatus; signers: { slot: number; display_name: string; status: SignerStatus }[] };

/**
 * Sits directly under the header and says, in one line, whether this family has
 * anything to do. It disappears entirely when they are up to date -- a banner
 * that is always present stops being read.
 */
export function ComplianceBanner({ items }: { items: ComplianceItem[] }) {
  const outstanding = outstandingCount(items.map((item) => item.row));
  if (!outstanding) return null;

  const names = items.filter((item) => !isSettled(item.row.status)).map((item) => item.requirement.title);

  return <aside className="compliance-banner" role="status">
    <span className="compliance-banner-count">{outstanding}</span>
    <div>
      <b>{outstanding === 1 ? "One thing needs your attention" : `${outstanding} things need your attention`}</b>
      <span>{names.join(" · ")}</span>
    </div>
    <a href="/family-village/paperwork">Take care of it →</a>
  </aside>;
}

/** The full list: every requirement for the year, settled or not. */
export function CompliancePanel({ items, signing = {} }: { items: ComplianceItem[]; signing?: Record<string, SigningInfo> }) {
  if (!items.length) {
    return <p className="portal-empty">Nothing is required of your family right now. Forms and dues will appear here when the Village sets them for the year.</p>;
  }

  const ordered = [...items].sort((a, b) => {
    // Anything outstanding floats to the top; settled items keep their order.
    const aDone = isSettled(a.row.status) ? 1 : 0;
    const bDone = isSettled(b.row.status) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return a.requirement.sort_order - b.requirement.sort_order;
  });

  return <ul className="compliance-list">
    {ordered.map((item) => <ComplianceRow key={item.row.id} item={item} signing={signing[item.row.id]} />)}
  </ul>;
}

function ComplianceRow({ item, signing }: { item: ComplianceItem; signing?: SigningInfo }) {
  const { row, requirement } = item;
  const settled = isSettled(row.status);
  const isDues = requirement.kind === "dues";

  async function openSignedCopy() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !row.signed_document_id) return;
    const { data } = await supabase.from("documents").select("storage_path").eq("id", row.signed_document_id).maybeSingle();
    if (!data?.storage_path) return;
    const url = await getSignedFileUrl(supabase, data.storage_path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return <li className={`compliance-item${settled ? " settled" : " outstanding"}`}>
    <div className="compliance-item-main">
      <b>{requirement.title}</b>
      {requirement.description && <span>{requirement.description}</span>}
      {isDues && row.amount_due !== null && <span className="compliance-amount">
        {formatMoney(Number(row.amount_due))}
        {settled && row.payment_method ? ` · ${row.payment_method}` : ""}
      </span>}
      {!settled && requirement.due_on && <span className="compliance-due">Due {formatDate(requirement.due_on)}</span>}
      {row.note && <span className="compliance-note">{row.note}</span>}
      {signing && signing.signers.length > 0 && <span className="compliance-signers">
        {signing.signers.map((s) => `${s.display_name}: ${s.status === "signed" ? "signed" : "not yet"}`).join(" · ")}
      </span>}
    </div>

    <span className={`status-pill ${statusTone(row.status)}`}>{statusLabel(requirement.kind, row)}</span>

    <div className="compliance-item-action">
      {/* Dues outstanding -- straight out to Crowded, which is where the co-op
          actually banks. The portal records receipt, it does not take payment. */}
      {isDues && <DuesLink paymentUrl={requirement.payment_url} settled={settled} />}

      {/* Signing happens here, in the portal, for a signed-in person. */}
      {!isDues && signing && signing.status !== "voided" &&
        <a className="compliance-cta" href={`/family-village/paperwork/sign?request=${signing.id}`}>
          {signing.status === "completed" ? "View signed copy" : signing.status === "signed" ? requestStatusLabel(signing.status) : "Review & sign"}
        </a>}

      {!settled && !isDues && !signing &&
        <span className="compliance-hint">The co-op has not sent this for signing yet. You will be notified when it arrives.</span>}

      {settled && !isDues && !signing && row.signed_document_id &&
        <button className="compliance-cta ghost" onClick={openSignedCopy}>Download copy</button>}
    </div>
  </li>;
}
