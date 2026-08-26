/**
 * Prints one element on the page without printing the rest of it.
 *
 * `printing-report` hides everything else via CSS; `print-target` marks the
 * one element that stays visible. Both classes come off again on `afterprint`
 * -- with a timeout fallback, since Safari doesn't reliably fire that event.
 */
export function printElement(target: HTMLElement | null) {
  if (!target) return;
  document.body.classList.add("printing-report");
  target.classList.add("print-target");
  const clean = () => {
    document.body.classList.remove("printing-report");
    target.classList.remove("print-target");
    window.removeEventListener("afterprint", clean);
  };
  window.addEventListener("afterprint", clean);
  window.print();
  window.setTimeout(clean, 1000);
}
