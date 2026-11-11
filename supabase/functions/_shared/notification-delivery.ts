import { escapeHtml, renderEmail } from "./email-template.ts";
import { safePath } from "./paths.ts";
import { buildSmsBody, type SmsProvider } from "./sms.ts";

/**
 * The sending half of the fallback ladder. The database decides who is owed an email or a
 * text and re-checks every rule when a row is claimed (public.claim_deliveries); this file
 * turns each claimed row into a message, sends it through the provider, and reports back.
 * Everything that touches the network comes in through `Deps`, so the tests use fakes.
 */

export const SITE = "https://family.veritasvillage.org";

export type ClaimedDelivery = {
  delivery_id: string;
  notification_id: string;
  user_id: string;
  channel: "email" | "sms";
  attempt: number;
  destination: string;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  urgent: boolean;
};

export type Outcome =
  | { status: "sent"; provider: string; messageId: string | null }
  | { status: "failed"; provider: string | null; error: string; retryable: boolean }
  | { status: "skipped"; provider: string | null; reason: string };

const EYEBROWS: Record<string, string> = {
  broadcast_urgent: "Urgent alert",
  broadcast_important: "Important notice",
  broadcast_notice: "A note from Veritas Village",
};

export function buildEmail(row: Pick<ClaimedDelivery, "kind" | "title" | "body" | "link_path" | "urgent">): { subject: string; html: string } {
  const paragraphs = (row.body ?? "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
    .map((part) => `<p style="margin:0 0 12px;">${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
  const preheader = escapeHtml((row.body ?? row.title).replace(/\s+/g, " ").slice(0, 110));
  const html = renderEmail({
    eyebrow: EYEBROWS[row.kind] ?? "Notification",
    heading: escapeHtml(row.title),
    bodyHtml: paragraphs || `<p style="margin:0;">Open Family Village to read it.</p>`,
    ctaLabel: "Open Family Village",
    ctaUrl: `${SITE}${safePath(row.link_path)}`,
    footerHtml: `You are getting this because you are part of Veritas Village. You can change how we reach you under Account settings in <a href="${SITE}/family-village/home" style="color:#5f6b61;">Family Village</a>.`,
    preheader,
  });
  return { subject: row.urgent ? `URGENT: ${row.title}` : row.title, html };
}

export type Deps = {
  /** Sends one email; the real one is built from Resend. */
  sendEmail: (row: ClaimedDelivery, message: { subject: string; html: string }) => Promise<Outcome>;
  sms: SmsProvider;
  /** Reports the result of one row to the database. */
  finish: (row: ClaimedDelivery, outcome: Outcome) => Promise<void>;
  /**
   * For dry runs: when set, anything not on the list is skipped without being sent. Compared
   * case-insensitively. Production leaves it unset.
   */
  allowList?: Set<string> | null;
  concurrency?: number;
};

export function parseAllowList(raw: string | null | undefined): Set<string> | null {
  const items = (raw ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? new Set(items) : null;
}

async function deliverOne(row: ClaimedDelivery, deps: Deps): Promise<Outcome> {
  if (deps.allowList && !deps.allowList.has(row.destination.toLowerCase())) {
    return { status: "skipped", provider: null, reason: "not_on_allowlist" };
  }
  if (row.channel === "email") return await deps.sendEmail(row, buildEmail(row));

  if (!deps.sms.live) return { status: "skipped", provider: deps.sms.name, reason: "provider_not_set_up" };
  const result = await deps.sms.send({
    to: row.destination,
    body: buildSmsBody({ title: row.title, body: row.body, urgent: row.urgent }),
    idempotencyKey: row.delivery_id,
  });
  return result.ok
    ? { status: "sent", provider: deps.sms.name, messageId: result.id }
    : { status: "failed", provider: deps.sms.name, error: result.error, retryable: !result.permanent };
}

/** Sends every claimed row, a few at a time. A row that throws is failed, never lost. */
export async function processDeliveries(rows: ClaimedDelivery[], deps: Deps): Promise<{ sent: number; failed: number; skipped: number }> {
  const tally = { sent: 0, failed: 0, skipped: 0 };
  const size = deps.concurrency ?? 10;
  for (let i = 0; i < rows.length; i += size) {
    await Promise.all(rows.slice(i, i + size).map(async (row) => {
      let outcome: Outcome;
      try {
        outcome = await deliverOne(row, deps);
      } catch (error) {
        outcome = { status: "failed", provider: null, error: error instanceof Error ? error.message : String(error), retryable: true };
      }
      tally[outcome.status] += 1;
      try {
        await deps.finish(row, outcome);
      } catch {
        // The row stays 'sending'; the ladder closes it as interrupted after 15 minutes.
      }
    }));
  }
  return tally;
}
