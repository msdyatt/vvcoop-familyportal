import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";
import { DEFAULT_EMAIL_BRAND, type EmailBrand } from "./email-template.ts";

/**
 * The co-op's name, logo and accent for emails, from public.coop_settings (issue #140; the web side is
 * lib/coop-theme.ts). Read once per minute per function instance. Anything missing or unreadable falls back
 * to the Veritas Village look: an email is never held up by its decoration.
 */
let cached: { at: number; brand: EmailBrand } | null = null;
const HEX = /^#[0-9a-f]{6}$/;

export function brandFromRow(row: Record<string, unknown> | null, supabaseUrl: string): EmailBrand {
  if (!row) return DEFAULT_EMAIL_BRAND;
  const accent = (row.accent ?? {}) as Record<string, unknown>;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : DEFAULT_EMAIL_BRAND.name;
  const path = typeof row.logo_light_path === "string" && /^logo_light\/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(row.logo_light_path) ? row.logo_light_path : null;
  const ratio = Number(row.logo_ratio);
  const both = HEX.test(String(accent.accent)) && HEX.test(String(accent.accent_text));
  return {
    name,
    logoUrl: path ? `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/coop-brand/${path}` : DEFAULT_EMAIL_BRAND.logoUrl,
    logoHeight: path && ratio >= 1 && ratio <= 6 ? Math.round(160 / ratio) : DEFAULT_EMAIL_BRAND.logoHeight,
    accent: both ? String(accent.accent) : DEFAULT_EMAIL_BRAND.accent,
    accentText: both ? String(accent.accent_text) : DEFAULT_EMAIL_BRAND.accentText,
    supportEmail: typeof row.support_email === "string" && /^[^@\s"<>]+@[^@\s"<>]+\.[^@\s"<>]+$/.test(row.support_email) ? row.support_email : null,
  };
}

export async function loadEmailBrand(admin: SupabaseClient): Promise<EmailBrand> {
  if (cached && Date.now() - cached.at < 60_000) return cached.brand;
  try {
    const { data } = await admin.from("coop_settings").select("name,accent,logo_light_path,logo_ratio,support_email").eq("id", "coop").maybeSingle();
    const brand = brandFromRow(data as Record<string, unknown> | null, Deno.env.get("SUPABASE_URL") ?? "");
    cached = { at: Date.now(), brand };
    return brand;
  } catch {
    return DEFAULT_EMAIL_BRAND;
  }
}
