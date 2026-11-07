"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";

/**
 * The action on a dues row of Paperwork & dues. While online payment is off it
 * is the old payment link (the co-op's Crowded page); once an administrator
 * turns online payment on, it is the Dues page, where the balance, schedule,
 * payments and receipts live. The provider is read once per page.
 */
let cached: Promise<string> | null = null;
function readProvider(): Promise<string> {
  if (!cached) {
    const supabase = getSupabaseBrowserClient();
    cached = supabase
      ? Promise.resolve(supabase.from("billing_settings").select("provider").eq("id", "dues").maybeSingle()).then(({ data }) => (data?.provider as string | undefined) ?? "off", () => "off")
      : Promise.resolve("off");
  }
  return cached;
}

export default function DuesLink({ paymentUrl, settled }: { paymentUrl: string | null; settled: boolean }) {
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readProvider().then((value) => { if (live) setProvider(value); });
    return () => { live = false; };
  }, []);

  if (provider && provider !== "off") {
    return <a className={`compliance-cta${settled ? " ghost" : ""}`} href="/family-village/dues">{settled ? "Receipts" : "Pay dues"}</a>;
  }
  if (!settled && paymentUrl) {
    return <a className="compliance-cta" href={paymentUrl} target="_blank" rel="noreferrer">Pay now ↗</a>;
  }
  return null;
}
