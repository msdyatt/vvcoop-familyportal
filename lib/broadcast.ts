/**
 * Pure helpers for the Broadcasts admin screen. Nothing here touches the network or the
 * browser, so it is tested directly (lib/broadcast.test.ts).
 */

export type Severity = "urgent" | "important" | "notice";
export const SEVERITIES: { value: Severity; label: string; hint: string }[] = [
  { value: "urgent", label: "Urgent", hint: "Goes out now on every way each person allows: phone, email, and text for those who agreed. Ignores “only urgent things” mode. Shows a banner until they tap Got it." },
  { value: "important", label: "Important", hint: "Phone first. If it isn’t seen after the wait (24 hours), it is emailed, and texted to those who agreed." },
  { value: "notice", label: "Notice", hint: "Phone first; people with no phone notifications get an email. Follows everyone’s own settings." },
];

export type Audience =
  | { type: "everyone" }
  | { type: "teachers" }
  | { type: "class"; class_id: string }
  | { type: "grade"; grade: string }
  | { type: "people"; user_ids: string[] };

export type Preview = {
  total: number; push: number; email_only: number; sms_only: number; unreachable: number;
  also_email: number; also_sms: number; email: number; sms: number; quiet_held: number; immediate: boolean;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "142 people: 118 push, 20 email only, 4 unreachable". Zero parts are left out. */
export function describePreview(p: Preview): string {
  const parts = [
    p.push ? `${p.push} push` : "",
    p.email_only ? `${p.email_only} email only` : "",
    p.sms_only ? `${p.sms_only} text only` : "",
    p.unreachable ? `${p.unreachable} unreachable` : "",
  ].filter(Boolean);
  return `${plural(p.total, "person", "people")}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/** The sentences under the headline: what else happens, and who will only find it in the app. */
export function describeExtras(p: Preview, severity: Severity): string[] {
  const lines: string[] = [];
  if (severity === "urgent") {
    if (p.email) lines.push(`${plural(p.email, "person gets", "people get")} an email right now.`);
    if (p.sms) lines.push(`${plural(p.sms, "person gets", "people get")} a text right now.`);
  } else {
    if (p.also_email) lines.push(`${plural(p.also_email, "more person", "more people")} will be emailed if they haven’t seen it after the wait.`);
    if (p.sms) lines.push(`${plural(p.sms, "person", "people")} who agreed to texts may also get one.`);
  }
  if (p.unreachable) lines.push(`${plural(p.unreachable, "person", "people")} can only find this in the app’s bell: no phone notifications, no email${severity === "urgent" ? "" : " (or they want only urgent things)"}.`);
  if (severity !== "urgent" && p.quiet_held) lines.push(`${plural(p.quiet_held, "person has", "people have")} “only urgent things” on, so this stays in their bell.`);
  return lines;
}

export function audienceReady(a: Audience): boolean {
  switch (a.type) {
    case "class": return Boolean(a.class_id);
    case "grade": return Boolean(a.grade);
    case "people": return a.user_ids.length > 0;
    default: return true;
  }
}

/** A key that changes whenever anything that affects the preview changes, so a stale preview can't be sent. */
export function previewKey(a: Audience, severity: Severity): string {
  return JSON.stringify([severity, a.type === "people" ? { ...a, user_ids: [...a.user_ids].sort() } : a]);
}

/** Looks like a template left unfilled, e.g. "[date]" or "TBD". Only used to ask "are you sure?". */
export function looksUnfinished(text: string): boolean {
  return /\[[^\]]{1,40}\]|\bTBD\b|\bXXX\b|lorem ipsum/i.test(text);
}
