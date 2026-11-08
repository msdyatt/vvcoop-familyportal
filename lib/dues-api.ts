import type { SupabaseClient } from "@supabase/supabase-js";
import { edgeFunctionUrl, functionErrorMessage } from "./supabase";

export type EmbedInfo = { clientSecret: string; publishableKey: string; chargeId: string };

/** Inside the iPhone or Android app, as opposed to a browser tab or an installed web app. */
export function isNativeApp(): boolean {
  return document.documentElement.dataset.shell === "native";
}

/**
 * Starts a payment for a charge.
 *
 * On the website the payment form is embedded in the page: this returns what the
 * page needs to show it. In the iPhone and Android apps it opens Stripe's own page
 * in the phone's browser instead, because Apple Pay and Google Pay do not work
 * inside an app's embedded web view. Either way the page never says how much;
 * the database decides.
 */
export async function startCheckout(supabase: SupabaseClient, input: { chargeId: string; payAll?: boolean; autopay?: boolean }): Promise<{ error?: string; embed?: EmbedInfo; opened?: boolean }> {
  const { data, error } = await supabase.functions.invoke("dues-checkout", { body: { ...input, embedded: !isNativeApp() } });
  if (error || data?.error) return { error: await functionErrorMessage(error, data, "The payment page could not be opened.") };

  if (data?.kind === "embedded" && typeof data.clientSecret === "string" && typeof data.publishableKey === "string") {
    return { embed: { clientSecret: data.clientSecret, publishableKey: data.publishableKey, chargeId: input.chargeId } };
  }
  if (typeof data?.url === "string" && data.url.startsWith("https://")) {
    // The app's own browser sheet (Safari View Controller on iPhone, a Custom Tab on Android),
    // which supports Apple Pay and Google Pay; anywhere else, a normal page navigation.
    const browser = (window as unknown as { Capacitor?: { Plugins?: { Browser?: { open: (o: { url: string }) => Promise<void> } } } }).Capacitor?.Plugins?.Browser;
    if (isNativeApp() && browser) await browser.open({ url: data.url });
    else window.location.assign(data.url);
    return { opened: true };
  }
  return { error: "The payment page could not be opened." };
}

/** Fetches the receipt PDF with the person's own session and hands it to the browser. */
export async function downloadReceipt(supabase: SupabaseClient, paymentId: string): Promise<string | null> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return "Please sign in again.";
  const response = await fetch(edgeFunctionUrl("dues-receipt"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ paymentId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return body?.error ?? "The receipt could not be created.";
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const nativeIos = document.documentElement.dataset.platform === "ios" && document.documentElement.dataset.shell === "native";
  if (nativeIos) {
    // The iOS app's web view cannot save a blob; showing it lets the person use the share sheet.
    window.open(url, "_blank");
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.download = `receipt-${paymentId.slice(0, 8)}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}
