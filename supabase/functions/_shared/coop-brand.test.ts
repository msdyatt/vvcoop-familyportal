import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { brandFromRow } from "./coop-brand.ts";
import { DEFAULT_EMAIL_BRAND, renderEmail } from "./email-template.ts";
import { buildInviteEmail, inviteSubject } from "./invite-email.ts";
import { buildEmail } from "./notification-delivery.ts";

const URL_ = "https://abc.supabase.co";
const meadow = { accent: "#4f8a55", accent_text: "#427d49" };

Deno.test("no settings row means the Veritas Village look", () => {
  assertEquals(brandFromRow(null, URL_), DEFAULT_EMAIL_BRAND);
});

Deno.test("the co-op's name, logo, shape and accent come from the settings row", () => {
  const brand = brandFromRow({ name: " Riverbend Co-op ", accent: meadow, logo_light_path: "logo_light/abc123.png", logo_ratio: 3.2, support_email: "office@riverbend.test" }, URL_);
  assertEquals(brand.name, "Riverbend Co-op");
  assertEquals(brand.logoUrl, "https://abc.supabase.co/storage/v1/object/public/coop-brand/logo_light/abc123.png");
  assertEquals(brand.logoHeight, 50);
  assertEquals(brand.accent, "#4f8a55");
  assertEquals(brand.accentText, "#427d49");
  assertEquals(brand.supportEmail, "office@riverbend.test");
});

Deno.test("anything odd in the row falls back rather than reaching the email", () => {
  const brand = brandFromRow({ name: "", accent: { accent: "red", accent_text: "#427d49" }, logo_light_path: "../x.png\"><script>", support_email: "x\"@y.z<" }, URL_);
  assertEquals(brand.name, DEFAULT_EMAIL_BRAND.name);
  assertEquals(brand.logoUrl, DEFAULT_EMAIL_BRAND.logoUrl);
  assertEquals(brand.accent, DEFAULT_EMAIL_BRAND.accent);
  assertEquals(brand.accentText, DEFAULT_EMAIL_BRAND.accentText);
  assertEquals(brand.supportEmail, null);
});

Deno.test("the email wears the brand: logo, name as alt text (escaped), accent rule and button", () => {
  const brand = brandFromRow({ name: "Oak & Ivy", accent: meadow, logo_light_path: "logo_light/a.png", logo_ratio: 4 }, URL_);
  const html = renderEmail({ eyebrow: "E", heading: "H", bodyHtml: "<p>B</p>", ctaLabel: "Go", ctaUrl: "https://x.test", brand });
  assertStringIncludes(html, 'src="https://abc.supabase.co/storage/v1/object/public/coop-brand/logo_light/a.png" width="160" height="40" alt="Oak &amp; Ivy"');
  assertStringIncludes(html, "background:#4f8a55;font-size:0");
  assertStringIncludes(html, '<td style="background:#427d49;">');
  assert(!html.includes("#bb6141"), "no Veritas terracotta left in a themed email");
});

Deno.test("without a brand the email is the Veritas Village one, with a text-safe button", () => {
  const html = renderEmail({ eyebrow: "E", heading: "H", bodyHtml: "<p>B</p>", ctaLabel: "Go", ctaUrl: "https://x.test" });
  assertStringIncludes(html, 'alt="Veritas Village"');
  assertStringIncludes(html, "/brand/lockup-horizontal-navy.png");
  assertStringIncludes(html, '<td style="background:#a85539;">');
});

Deno.test("invitations and notices use the co-op's name", () => {
  const brand = brandFromRow({ name: "Riverbend Co-op", accent: meadow }, URL_);
  const invite = buildInviteEmail({ adminName: "Jo", familyName: "Lewis", existingHousehold: false, actionLink: "https://x.test" }, brand);
  assertStringIncludes(invite, "the private home for Riverbend Co-op families.");
  assert(!invite.includes("Veritas Village"));
  assertEquals(inviteSubject(brand), "You're invited to Riverbend Co-op Family Village");
  assertEquals(inviteSubject(), "You're invited to Veritas Village Family Village");
  const notice = buildEmail({ kind: "broadcast_notice", title: "Picnic", body: "Bring a dish.", link_path: "/family-village/home", urgent: false }, brand);
  assertStringIncludes(notice.html, "A note from Riverbend Co-op");
  assertStringIncludes(notice.html, "because you are part of Riverbend Co-op.");
});
