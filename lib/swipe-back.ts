/**
 * Swipe in from the left edge to go back.
 *
 * Only for the installed web app: a home-screen web app on iPhone has no back
 * gesture of its own, while a browser tab and the native app already do (the
 * native shell turns it on in ViewController). Pages here are separate loads,
 * so "back" is the browser's history, and this simply asks for it.
 *
 * It stays out of the way of things that scroll or type: a swipe that starts
 * inside a sideways-scrolling area (a wide table, the calendar), a field, or
 * an open dialog is left alone.
 */

const EDGE_PX = 24;
const MIN_DISTANCE_PX = 80;
const MAX_DRIFT_PX = 60;

function inSidewaysScroller(node: Element | null): boolean {
  for (let element = node; element && element !== document.body; element = element.parentElement) {
    const overflowX = getComputedStyle(element).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth) return true;
  }
  return false;
}

export function initSwipeBack(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  if (root.dataset.shell !== "standalone") return () => {};

  let start: { x: number; y: number } | null = null;

  const onStart = (event: TouchEvent) => {
    start = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX > EDGE_PX) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true'], dialog[open]")) return;
    if (inSidewaysScroller(target)) return;
    start = { x: touch.clientX, y: touch.clientY };
  };

  const onEnd = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    start = null;
    if (dx >= MIN_DISTANCE_PX && dy <= MAX_DRIFT_PX && window.history.length > 1) window.history.back();
  };

  const onCancel = () => { start = null; };

  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", onCancel, { passive: true });
  return () => {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onCancel);
  };
}
