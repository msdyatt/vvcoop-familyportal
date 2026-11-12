/**
 * Swipe in from the left edge to go back.
 *
 * For the installed web app and the Android app, which have no browser chrome:
 * a browser tab already has its own gesture, and the iPhone app's native frame
 * brings the system's. Pages here are separate loads, so
 * "back" is the browser's history, and this asks for it. Popups, reports and
 * open conversations are history steps too (see back-layers.ts), so the same
 * swipe closes them.
 *
 * A round arrow follows the finger so there is visible proof it is working,
 * and it fires only when the swipe is long enough. It stays out of the way of
 * things that scroll or type: a swipe that starts inside a sideways-scrolling
 * area (a wide table, the calendar) or a field is left alone.
 */

const EDGE_PX = 28;
const MIN_DISTANCE_PX = 80;
const MAX_DRIFT_PX = 60;

function inSidewaysScroller(node: Element | null): boolean {
  for (let element = node; element && element !== document.body; element = element.parentElement) {
    const overflowX = getComputedStyle(element).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth) return true;
  }
  return false;
}

function makeArrow(): HTMLDivElement {
  const arrow = document.createElement("div");
  arrow.setAttribute("aria-hidden", "true");
  arrow.style.cssText = [
    "position:fixed", "z-index:2147483000", "top:50%", "left:0", "width:44px", "height:44px", "margin-top:-22px",
    "display:grid", "place-items:center", "border-radius:50%", "background:var(--ink-surface)", "color:var(--cream)",
    "font:700 22px/1 -apple-system,system-ui,sans-serif", "box-shadow:0 4px 14px rgba(var(--shadow-rgb),.35)",
    "pointer-events:none", "opacity:0", "transform:translateX(-60px)",
  ].join(";");
  arrow.textContent = "‹";
  document.body.appendChild(arrow);
  return arrow;
}

export function initSwipeBack(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  if (root.dataset.app !== "1") return () => {};
  // The iPhone app's native frame has its own edge swipe (and closes popups first); two would both fire.
  if (root.dataset.frame) return () => {};

  let start: { x: number; y: number } | null = null;
  let arrow: HTMLDivElement | null = null;

  const hideArrow = () => {
    if (!arrow) return;
    const gone = arrow;
    arrow = null;
    gone.style.transition = "opacity .18s, transform .18s";
    gone.style.opacity = "0";
    gone.style.transform = "translateX(-60px)";
    window.setTimeout(() => gone.remove(), 220);
  };

  const onStart = (event: TouchEvent) => {
    start = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX > EDGE_PX) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (inSidewaysScroller(target)) return;
    start = { x: touch.clientX, y: touch.clientY };
  };

  const onMove = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.touches[0];
    const dx = touch.clientX - start.x;
    if (dx < 6 || Math.abs(touch.clientY - start.y) > MAX_DRIFT_PX * 2) { hideArrow(); return; }
    arrow ??= makeArrow();
    const progress = Math.min(1, dx / MIN_DISTANCE_PX);
    arrow.style.transition = "none";
    arrow.style.opacity = String(0.35 + 0.65 * progress);
    arrow.style.transform = `translateX(${-60 + 76 * progress}px)`;
  };

  const onEnd = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    start = null;
    hideArrow();
    if (dx >= MIN_DISTANCE_PX && dy <= MAX_DRIFT_PX && window.history.length > 1) window.history.back();
  };

  const onCancel = () => { start = null; hideArrow(); };

  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", onCancel, { passive: true });
  return () => {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onCancel);
    hideArrow();
  };
}
