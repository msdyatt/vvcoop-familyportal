/**
 * Makes screens that live inside a page, such as a popup, a report, or an open
 * conversation, count as steps for the Back button and the swipe-back gesture.
 *
 * Moving between pages already adds history entries, because each page is a
 * real load. But opening a popup or picking a report only changes what is
 * drawn, so Back had nothing to undo and left the whole page instead.
 *
 * Opening one of these screens pushes a history entry; going Back (button or
 * gesture) closes the screen instead of leaving the page. If the screen is
 * closed some other way, such as its own close button, the extra entry is
 * removed so Back does not need pressing twice. Layers stack, so Back closes
 * the topmost first.
 */

type Layer = { id: number; close: () => void };

const stack: Layer[] = [];
let ignoredPops = 0;
let listening = false;
let sequence = 0;

function onPopState() {
  // A pop that this module caused itself (removing an entry for a screen closed by the UI).
  if (ignoredPops > 0) { ignoredPops -= 1; return; }
  stack.pop()?.close();
}

/** Opens a layer; returns the function that releases it when the screen closes for any other reason. */
export function pushBackLayer(close: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (!listening) { window.addEventListener("popstate", onPopState); listening = true; }
  const layer: Layer = { id: ++sequence, close };
  stack.push(layer);
  window.history.pushState(window.history.state, "");
  const marker = window.history.state;

  return () => {
    const index = stack.indexOf(layer);
    if (index === -1) return; // Back already closed it.
    stack.splice(index, 1);
    // Closed by the screen itself: take its history entry back out, but only if it is still the newest.
    if (index === stack.length && window.history.state === marker) {
      ignoredPops += 1;
      window.history.back();
    }
  };
}
