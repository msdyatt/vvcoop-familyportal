/**
 * Prints one element on the page without printing the rest of it.
 *
 * Marks the target and its ancestor chain up to <body> so the print CSS
 * (see the `@media print` block in globals.css) can hide everything else
 * with display:none -- collapsing its layout space, which visibility:hidden
 * (the first version of this) did not, and without disturbing the target's
 * own flex/grid layout the way reverting every descendant's display would.
 */
export function printElement(target: HTMLElement | null) {
  if (!target) return;
  const ancestors: HTMLElement[] = [];
  let node = target.parentElement;
  while (node && node !== document.body) {
    ancestors.push(node);
    node = node.parentElement;
  }

  document.body.classList.add("printing-report");
  target.classList.add("print-target");
  ancestors.forEach((el) => el.classList.add("print-ancestor"));

  const clean = () => {
    document.body.classList.remove("printing-report");
    target.classList.remove("print-target");
    ancestors.forEach((el) => el.classList.remove("print-ancestor"));
    window.removeEventListener("afterprint", clean);
  };
  window.addEventListener("afterprint", clean);
  window.print();
  // A fallback only -- afterprint fires reliably in every browser this app
  // actually supports, so this exists purely for the browser where it
  // somehow doesn't. One second used to be the fallback delay, which meant
  // any print dialog left open longer than that (reviewing printer/page
  // settings is routine) had its scoping classes stripped mid-dialog,
  // defeating "print just this report" and printing the whole page instead.
  window.setTimeout(clean, 60_000);
}
