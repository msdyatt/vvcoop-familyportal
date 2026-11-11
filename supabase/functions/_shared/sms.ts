/**
 * Text messages (SMS), behind one small interface so the co-op can pick a provider later
 * without touching anything else. Today there is only the stub, which sends nothing: it
 * exists so the whole path (consent, queueing, claiming, logging) is real and tested before
 * a texting account exists. Carrier registration for a US number takes weeks, and until it
 * is done nothing may be sent.
 *
 * Adding a provider = a new object that satisfies SmsProvider, registered in PROVIDERS below,
 * and its key stored in Supabase Vault. See docs/notification-ladder.md.
 *
 * Two-way texting (replies, conversations) is deliberately not here. The only inbound message
 * the design expects is STOP, which the provider reports to public.record_sms_opt_out.
 */

export type SmsMessage = { to: string; body: string; idempotencyKey: string };
export type SmsResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string; /** True when trying again cannot help (a landline, an invalid number, no account). */ permanent: boolean };

export interface SmsProvider {
  readonly name: string;
  /** False for the stub: the runner records the text as skipped instead of sent. */
  readonly live: boolean;
  send(message: SmsMessage): Promise<SmsResult>;
}

/** Sends nothing, ever. Never touches the network. */
export const stubSmsProvider: SmsProvider = {
  name: "stub",
  live: false,
  send() {
    return Promise.resolve({ ok: false, error: "No texting provider is set up yet.", permanent: true });
  },
};

/** Real providers by the name stored in notification_settings.sms_provider. Empty until one is built. */
export const PROVIDERS: Record<string, (config: { secret: string }) => SmsProvider> = {};

export function resolveSmsProvider(name: string | null | undefined, secret: string | null): SmsProvider {
  const make = name ? PROVIDERS[name] : undefined;
  // An unknown name, or a known one with no key yet, must fall back to sending nothing.
  if (!make || !secret) return stubSmsProvider;
  return make({ secret });
}

export const SMS_FOOTER = "Reply STOP to opt out, HELP for help.";
const SMS_LIMIT = 300; // two segments of plain text; longer would be split and cost more

/**
 * "Veritas Village: <title>. <body> <footer>", cut to fit. The STOP/HELP footer is always kept:
 * carriers require every program message to say how to opt out. Plain characters only, so it
 * stays in the cheap GSM encoding.
 */
export function buildSmsBody(opts: { title: string; body: string | null; urgent: boolean }): string {
  const clean = (value: string) => value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  const prefix = opts.urgent ? "URGENT - Veritas Village: " : "Veritas Village: ";
  const tail = ` ${SMS_FOOTER}`;
  const core = clean([opts.title, opts.body ?? ""].filter(Boolean).join(". "));
  const room = SMS_LIMIT - prefix.length - tail.length;
  const trimmed = core.length > room ? `${core.slice(0, room - 3).trimEnd()}...` : core;
  return `${prefix}${trimmed}${tail}`;
}
