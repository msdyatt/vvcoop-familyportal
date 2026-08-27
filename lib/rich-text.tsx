"use client";

import { useEffect, useState } from "react";
import filterXSS from "xss";
import { getSupabaseBrowserClient } from "./supabase";
import { getSignedFileUrls } from "./storage";

const ALLOW_LIST = {
  p: [], br: [], strong: [], em: [], u: [],
  h2: [], h3: [], h4: [], ul: [], ol: [], li: [], blockquote: [],
  a: ["href"],
  // Deliberately no "src" here -- an inline image is a reference to a file in
  // the private bucket (data-path), never a raw URL. A pasted <img src="...">
  // has its src stripped by filterXSS below and only data-path/alt survive,
  // which is also what keeps this safe against a javascript: src.
  img: ["data-path", "alt"],
};

function escapeText(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character] ?? character));
}

// Matches only an opening tag from ALLOW_LIST -- "<p>", "<strong>", "<a href=...>"
// and so on. A generic "any angle-bracket sequence" pattern also matched plain
// text containing an email address in brackets ("<admin@vv.org>"), routing it
// into filterXSS below, which silently deleted it as an unrecognized tag.
// Checking for a real allow-listed tag name is what the plain-text/HTML
// distinction actually needs -- ordinary text essentially never contains a
// bare "<p" or "<strong>", so this doesn't reintroduce false positives the
// other direction.
const HTML_TAG_PATTERN = new RegExp(`<(${Object.keys(ALLOW_LIST).join("|")})[\\s>/]`, "i");

/** Sanitize on save and again on render so older or API-written rows stay safe. */
export function sanitizeRichText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!HTML_TAG_PATTERN.test(trimmed)) {
    return trimmed.split(/\n{2,}/).map((paragraph) => `<p>${escapeText(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
  }
  return filterXSS(trimmed, {
    whiteList: ALLOW_LIST,
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style"],
  });
}

export function stripRichText(value: string) {
  const text = filterXSS(value, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style"],
  });
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every `data-path` an inline <img> in this HTML carries -- also what makes an image-only post (no text at all) tell apart from a genuinely empty one. */
export function inlineImagePaths(html: string): string[] {
  const paths = new Set<string>();
  const pattern = /data-path="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) if (match[1]) paths.add(match[1]);
  return [...paths];
}

/**
 * Turns every `data-path="..."` on an <img> into a live `src`.
 *
 * The private bucket means an embedded image can only ever be a path
 * reference, never a baked-in URL (a signed URL expires; the file's location
 * doesn't). Shared between RichText's render and the editor's own preview so
 * both resolve the same way.
 */
export async function resolveInlineImages(html: string): Promise<string> {
  const paths = inlineImagePaths(html);
  if (!paths.length) return html;
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return html;
  const urls = await getSignedFileUrls(supabase, paths);
  let resolved = html;
  urls.forEach((url, path) => {
    resolved = resolved.split(`data-path="${path}"`).join(`data-path="${path}" src="${url}"`);
  });
  return resolved;
}

export default function RichText({ html, className = "rich-text" }: { html: string; className?: string }) {
  const clean = sanitizeRichText(html);
  const [display, setDisplay] = useState(clean);

  useEffect(() => {
    let cancelled = false;
    resolveInlineImages(clean).then((resolved) => { if (!cancelled) setDisplay(resolved); });
    return () => { cancelled = true; };
  }, [clean]);

  return <div className={className} dangerouslySetInnerHTML={{ __html: display }} />;
}
