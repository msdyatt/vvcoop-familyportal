/**
 * Big, hard-to-miss confirmations.
 *
 * Across the portal, the result of an action ("Saved.", "Could not send") shows
 * as a small line of text near the button, which is easy to miss, especially on
 * a phone. Those lines all share a few class names, so instead of editing each
 * one, this watches for them: when one appears or changes right after someone
 * tapped something, the same message is shown as a large banner at the top of
 * the screen. The original line stays in place (it is what screen readers
 * announce), so the banner is hidden from them.
 */

const MESSAGE_SELECTOR = ".admin-form-status, .setup-note, .messages-status";
const INTERACTION_WINDOW_MS = 15_000;
const SHOW_MS = 5_000;
const SHOW_ERROR_MS = 8_000;
const MAX_VISIBLE = 3;

const ERROR_WORDS = /\b(could not|couldn't|can't|cannot|not able|unable|failed|failure|error|invalid|denied|not allowed|wrong|expired|too long|too many|try again|something went wrong|no longer|isn't|not valid|rejected)\b/i;

export function toneOf(text: string): "success" | "error" {
  return ERROR_WORDS.test(text) ? "error" : "success";
}

/** Progress lines ("Saving…") are not results; the banner waits for the outcome. */
export function isProgress(text: string): boolean {
  return /(…|\.\.\.)\s*$/.test(text);
}

export function initToaster(): () => void {
  if (typeof document === "undefined") return () => {};

  let lastInteraction = 0;
  const markInteraction = () => { lastInteraction = Date.now(); };
  const interactionEvents = ["click", "keydown", "submit", "change", "touchend"] as const;
  interactionEvents.forEach((name) => document.addEventListener(name, markInteraction, true));

  const lane = document.createElement("div");
  lane.className = "vv-toasts";
  document.body.appendChild(lane);

  // The text each message line held when first seen, so a line that resets to its
  // standing default (sign-in's "Access is granted by invitation…") is not announced.
  const standing = new WeakMap<Element, string>();
  const born = new WeakMap<Element, number>();
  const lastShown = new Map<string, number>();

  function show(text: string) {
    const now = Date.now();
    if ((lastShown.get(text) ?? 0) > now - 2_000) return;
    lastShown.set(text, now);

    const tone = toneOf(text);
    const toast = document.createElement("div");
    toast.className = `vv-toast ${tone}`;
    toast.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "vv-toast-icon";
    icon.textContent = tone === "error" ? "!" : "✓";
    const label = document.createElement("span");
    label.className = "vv-toast-text";
    label.textContent = text;
    const close = document.createElement("span");
    close.className = "vv-toast-close";
    close.textContent = "×";
    toast.append(icon, label, close);

    const remove = () => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 220);
    };
    toast.addEventListener("click", remove);
    lane.prepend(toast);
    while (lane.children.length > MAX_VISIBLE) lane.lastElementChild?.remove();
    window.setTimeout(remove, tone === "error" ? SHOW_ERROR_MS : SHOW_MS);
  }

  function consider(element: Element, isNew: boolean) {
    const text = (element.textContent ?? "").trim();
    // A line that has only just been rendered (possibly empty, then filled in) is a new message.
    const fresh = isNew || (!standing.has(element) && Date.now() - (born.get(element) ?? 0) < 500);
    if (!fresh && !standing.has(element)) { standing.set(element, text); return; }
    if (!text || isProgress(text)) return;
    if (!fresh && text === standing.get(element)) return;
    if (Date.now() - lastInteraction > INTERACTION_WINDOW_MS) return;
    show(text);
  }

  document.querySelectorAll(MESSAGE_SELECTOR).forEach((element) => standing.set(element, (element.textContent ?? "").trim()));

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      // A message that was just rendered by itself. A whole page or tab appearing
      // (which merely contains one) is not a result, so only the node itself counts.
      record.addedNodes.forEach((node) => {
        if (node instanceof Element && node.matches(MESSAGE_SELECTOR)) { born.set(node, Date.now()); consider(node, true); }
      });
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const message = target?.closest(MESSAGE_SELECTOR);
      if (message) consider(message, false);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  return () => {
    observer.disconnect();
    interactionEvents.forEach((name) => document.removeEventListener(name, markInteraction, true));
    lane.remove();
  };
}
