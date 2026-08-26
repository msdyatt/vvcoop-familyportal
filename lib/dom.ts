/**
 * Prints one element on the page without printing the rest of it.
 *
 * `visibility:hidden` on everything else was the first version of this, but
 * visibility doesn't remove an element from layout -- the rest of the (now
 * invisible) admin page still occupied its normal height, so a
 * position:absolute; inset:0 print-target got stretched to match a
 * containing block that could be several print-pages tall, spilling the
 * roster across mostly-blank extra pages. `display:none` on everything
 * except the target's own ancestor chain actually removes that layout
 * space, so the printed page is sized by the target's own content instead
 * of by whatever else happened to be on screen.
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
  window.setTimeout(clean, 1000);
}
