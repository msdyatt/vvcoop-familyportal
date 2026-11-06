import type { SupabaseClient } from "@supabase/supabase-js";
import { edgeFunctionUrl, functionErrorMessage } from "./supabase";

/** Opens Stripe's hosted page for a charge. Returns an error message, or null after navigating. */
export async function startCheckout(supabase: SupabaseClient, input: { chargeId: string; payAll?: boolean; autopay?: boolean }): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("dues-checkout", { body: input });
  if (error || data?.error) return functionErrorMessage(error, data, "The payment page could not be opened.");
  if (!data?.url || typeof data.url !== "string" || !data.url.startsWith("https://")) return "The payment page could not be opened.";
  window.location.assign(data.url);
  return null;
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
