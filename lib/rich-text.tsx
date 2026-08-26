import filterXSS from "xss";

const ALLOW_LIST = {
  p: [], br: [], strong: [], em: [], u: [],
  h2: [], h3: [], h4: [], ul: [], ol: [], li: [], blockquote: [],
  a: ["href"],
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

export default function RichText({ html, className = "rich-text" }: { html: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeRichText(html) }} />;
}
