/**
 * A small, hand-rolled branded email wrapper -- table-based and inline-styled
 * throughout, since email clients don't reliably support flexbox/grid or
 * external stylesheets.
 *
 * This deliberately mirrors the "email-paper" preview already built into the
 * admin invite form (app/family-village/admin/workspace.tsx, styled in
 * app/globals.css around .email-paper/.email-vv/.email-rule/.email-button)
 * -- that preview was the established design; this is what makes the real,
 * sent email actually look like it instead of drifting into its own design.
 * Keep the two in sync if either changes.
 *
 * The logo is a real hosted image, not styled text -- email clients can't
 * see this project's web fonts, so a text wordmark either falls back to a
 * generic serif or (worse) renders in the wrong face entirely.
 */
const LOGO_URL = "https://family.veritasvillage.org/brand/lockup-horizontal-navy.png";

/**
 * Escapes a plain-text value (an admin-typed name, a free-text note) before
 * it's spliced into an *Html field below. `bodyHtml`/`noteHtml` are named for
 * what they hold -- real markup a caller composed on purpose (`<p>...</p>`) --
 * so this is meant for the individual dynamic values a caller interpolates
 * into that markup, not the markup itself. Skipping this let a stray `&`/`<`
 * in a pasted note break the card's layout, or a deliberate `<a>`/`<img>` tag
 * ride along inside a branded email recipients are primed to trust.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

export function renderEmail(opts: {
  eyebrow: string;
  heading: string;
  bodyHtml: string;
  noteHtml?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footerHtml?: string;
  preheader?: string;
}): string {
  const { eyebrow, heading, bodyHtml, noteHtml, ctaLabel, ctaUrl, footerHtml, preheader } = opts;
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#faf7f1;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f1;padding:32px 16px;">
<tr><td align="center">
<!-- A filled navy frame around the cream card, not a thin CSS border --
     table borders render inconsistently across email clients (Outlook in
     particular), while a padded, background-colored outer cell is the
     technique that actually holds up everywhere. Matches the navy frame the
     admin's own "email-paper" preview has always had. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0b2a3d;padding:10px;">
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f1;">
<tr><td style="padding:38px;background:#faf7f1;">
<img src="${LOGO_URL}" width="160" height="55" alt="Veritas Village" style="display:block;border:0;margin:0 0 18px;">
<span style="display:block;width:42px;height:2px;margin:0 0 28px;background:#bb6141;font-size:0;line-height:0;">&nbsp;</span>
<p style="margin:0 0 4px;color:#5f6b61;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;">${eyebrow}</p>
<h1 style="margin:5px 0 22px;color:#0b2a3d;font-family:Georgia,'Times New Roman',serif;font-size:31px;line-height:1.05;font-weight:700;">${heading}</h1>
<div style="color:#5f6b61;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;">${bodyHtml}</div>
${noteHtml ? `<div style="margin:18px 0;padding:12px 16px;color:#0b2a3d;font-family:Arial,Helvetica,sans-serif;font-style:italic;font-size:14px;border-left:3px solid #bb6141;">${noteHtml}</div>` : ""}
${ctaLabel && ctaUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 13px;"><tr><td style="background:#bb6141;"><a href="${ctaUrl}" style="display:inline-block;padding:12px 17px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;text-decoration:none;">${ctaLabel}</a></td></tr></table>` : ""}
${footerHtml ? `<p style="display:block;margin:0;color:#5f6b61;font-family:Arial,Helvetica,sans-serif;font-size:12px;">${footerHtml}</p>` : ""}
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
