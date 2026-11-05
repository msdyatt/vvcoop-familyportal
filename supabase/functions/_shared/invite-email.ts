import { escapeHtml, renderEmail } from "./email-template.ts";

export type InviteEmailInput = { adminName: string; familyName: string; existingHousehold: boolean; note?: string; actionLink: string };

/** The invitation email, shared by the first send and a resend so they can never drift apart. */
export function buildInviteEmail({ adminName, familyName, existingHousehold, note, actionLink }: InviteEmailInput): string {
  // adminName/familyName are admin-typed free text, not markup -- escape
  // before splicing into the *Html fields below, or a stray "&"/"<" (or a
  // deliberate tag) breaks the card layout or rides along inside an email
  // recipients are primed to trust. The note is plain text too; \n -> <br>
  // after escaping keeps line breaks without opening the door to raw HTML.
  const safeAdminName = escapeHtml(adminName);
  const safeFamilyName = escapeHtml(familyName);
  const safeNote = note ? escapeHtml(note).replace(/\n/g, "<br>") : undefined;
  return renderEmail({
    eyebrow: "You're invited",
    heading: existingHousehold ? "There is a place for you at the table." : "There is a place for your family at the table.",
    preheader: `${safeAdminName}, ${safeFamilyName}'s invitation to Veritas Village is ready.`,
    bodyHtml: existingHousehold
      ? `<p>Hello ${safeAdminName},</p><p>You have been invited to join the <b>${safeFamilyName}</b> household in Family Village, Veritas Village's private portal for classes, schedules, notes, and paperwork.</p>`
      : `<p>Hello ${safeAdminName},</p><p>You have been invited to join Family Village, the private home for Veritas Village families.</p>`,
    noteHtml: safeNote,
    ctaLabel: "Accept your invitation",
    ctaUrl: actionLink,
    footerHtml: "This private link expires in 24 hours.",
  });
}

export const INVITE_SUBJECT = "You're invited to Veritas Village Family Village";
