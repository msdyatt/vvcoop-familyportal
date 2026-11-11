import type { SupabaseClient } from "@supabase/supabase-js";
import { edgeFunctionUrl, functionErrorMessage } from "./supabase";
import { shareBlob } from "./native-frame";

/** Apple's identifier for the co-op's Apple Pay merchant account (created in the Apple Developer account). */
export const APPLE_MERCHANT_ID = "merchant.org.veritasvillage.family";
/** The app's custom URL scheme, used when a bank's own page sends the person back to the app. */
export const APP_RETURN_URL = "org.veritasvillage.family://stripe-redirect";

type StripePlugin = {
  initialize: (o: { publishableKey: string }) => Promise<void>;
  createPaymentSheet: (o: Record<string, unknown>) => Promise<void>;
  handleURLCallback?: (o: { url: string }) => Promise<void>;
  presentPaymentSheet: () => Promise<{ paymentResult: "paymentSheetCompleted" | "paymentSheetCanceled" | "paymentSheetFailed" }>;
};
type CapacitorGlobal = { isPluginAvailable?: (name: string) => boolean; Plugins?: { App?: { addListener: (e: string, cb: (o: { url: string }) => void) => unknown }; Stripe?: StripePlugin; Browser?: { open: (o: { url: string }) => Promise<void> } } };
const capacitor = () => (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

/** True in an app build that includes Stripe's native payment sheet; older builds use the browser sheet. */
export function hasNativePayments(): boolean {
  const cap = capacitor();
  return isNativeApp() && Boolean(cap?.Plugins?.Stripe) && (cap?.isPluginAvailable?.("Stripe") ?? true);
}

let returnHandlerRegistered = false;
/** A bank's page opened by Stripe sends the person back through the app's URL scheme; hand that to Stripe. */
function registerReturnHandler() {
  if (returnHandlerRegistered) return;
  const cap = capacitor();
  const stripe = cap?.Plugins?.Stripe;
  if (!cap?.Plugins?.App || !stripe?.handleURLCallback) return;
  returnHandlerRegistered = true;
  cap.Plugins.App.addListener("appUrlOpen", ({ url }) => {
    if (url.startsWith(APP_RETURN_URL.split("://")[0] + "://")) void stripe.handleURLCallback?.({ url });
  });
}

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
export async function startCheckout(supabase: SupabaseClient, input: { chargeId: string; payAll?: boolean; autopay?: boolean }): Promise<{ error?: string; embed?: EmbedInfo; opened?: boolean; completed?: boolean }> {
  const native = hasNativePayments();
  const { data, error } = await supabase.functions.invoke("dues-checkout", { body: { ...input, embedded: !isNativeApp(), native } });
  if (error || data?.error) return { error: await functionErrorMessage(error, data, "The payment page could not be opened.") };

  if (data?.kind === "native" && native) {
    // Stripe's own payment sheet, native to the phone: Apple Pay / Google Pay, bank, or card. The
    // details are entered into Stripe's sheet and never pass through this page.
    const stripe = capacitor()!.Plugins!.Stripe!;
    registerReturnHandler();
    try {
      await stripe.initialize({ publishableKey: data.publishableKey });
      await stripe.createPaymentSheet({
        paymentIntentClientSecret: data.paymentIntentClientSecret, customerId: data.customerId, merchantDisplayName: data.merchantDisplayName,
        enableApplePay: true, applePayMerchantId: APPLE_MERCHANT_ID, enableGooglePay: true, GooglePayIsTesting: String(data.publishableKey).startsWith("pk_test_"),
        countryCode: "US", currencyCode: "usd", allowsDelayedPaymentMethods: true, paymentMethodLayout: "vertical", returnURL: APP_RETURN_URL,
      });
      const { paymentResult } = await stripe.presentPaymentSheet();
      if (paymentResult === "paymentSheetCompleted") return { completed: true };
      if (paymentResult === "paymentSheetFailed") return { error: "The payment did not go through. You were not charged. Please try again." };
      return {};   // closed without paying: the attempt stays open and resumes next time
    } catch {
      return { error: "The payment sheet could not be opened. Please try again." };
    }
  }
  if (data?.kind === "embedded" && typeof data.clientSecret === "string" && typeof data.publishableKey === "string") {
    return { embed: { clientSecret: data.clientSecret, publishableKey: data.publishableKey, chargeId: input.chargeId } };
  }
  if (typeof data?.url === "string" && data.url.startsWith("https://")) {
    // The app's own browser sheet (Safari View Controller on iPhone, a Custom Tab on Android),
    // which supports Apple Pay and Google Pay; anywhere else, a normal page navigation.
    const browser = capacitor()?.Plugins?.Browser;
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
  // The iPhone app's native frame has its own share sheet (Save to Files, Print, Mail...).
  try { if (await shareBlob(blob, `receipt-${paymentId.slice(0, 8)}.pdf`)) return null; } catch { /* fall back below */ }
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
