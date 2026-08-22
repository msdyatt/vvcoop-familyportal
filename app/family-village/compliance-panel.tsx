"use client";

import { getSupabaseBrowserClient } from "../../lib/supabase";
import { getSignedFileUrl } from "../../lib/storage";
import {
  FamilyRequirement, Requirement, formatDate, formatMoney,
  isSettled, outstandingCount, statusLabel, statusTone,
} from "../../lib/compliance";

export type ComplianceItem = { row: FamilyRequirement; requirement: Requirement };

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
    <a href="#paperwork">Take care of it →</a>
  </aside>;
}

/** The full list: every requirement for the year, settled or not. */
export function CompliancePanel({ items }: { items: ComplianceItem[] }) {
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
    {ordered.map((item) => <ComplianceRow key={item.row.id} item={item} />)}
  </ul>;
}

function ComplianceRow({ item }: { item: ComplianceItem }) {
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
    </div>

    <span className={`status-pill ${statusTone(row.status)}`}>{statusLabel(requirement.kind, row)}</span>

    <div className="compliance-item-action">
      {/* Dues outstanding -- straight out to Crowded, which is where the co-op
          actually banks. The portal records receipt, it does not take payment. */}
      {!settled && isDues && requirement.payment_url &&
        <a className="compliance-cta" href={requirement.payment_url} target="_blank" rel="noreferrer">Pay now ↗</a>}

      {/* Two ways a document can be signed. A per-family link from an API send
          takes precedence when one exists, because it is tied to this household;
          otherwise the co-op's shared public template link is used. Both open in
          a new tab -- OpenSign's signing page fetches inside an iframe but
          renders nothing, so embedding it would show families an empty box. */}
      {!settled && !isDues && (row.signing_url || requirement.public_sign_url) &&
        <a className="compliance-cta" href={(row.signing_url ?? requirement.public_sign_url)!} target="_blank" rel="noreferrer">Sign now ↗</a>}

      {!settled && !isDues && !row.signing_url && !requirement.public_sign_url &&
        <span className="compliance-hint">A signing link will appear here shortly.</span>}

      {settled && !isDues && row.signed_document_id &&
        <button className="compliance-cta ghost" onClick={openSignedCopy}>Download copy</button>}
    </div>
  </li>;
}
