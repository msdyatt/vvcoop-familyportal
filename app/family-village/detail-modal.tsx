"use client";

import { useEffect, useId, useRef } from "react";

/**
 * QA finding VV-20: this used to be a plain `role="dialog"` div -- real
 * enough for a screen reader to announce as a dialog, but with none of the
 * behavior that makes one usable: no accessible name when there's no title,
 * nothing moved focus into it on open, Tab could still reach the page
 * underneath, and closing it never gave focus back to whatever opened it.
 *
 * A native <dialog>, opened via showModal(), gets most of that for free from
 * the browser itself: a real focus trap, the rest of the page marked inert,
 * top-layer stacking with no z-index to manage, and focus moved in
 * automatically. Only the accessible name and focus restoration on close are
 * still this component's job.
 */
export default function DetailModal({ title, onClose, children }: { title?: string; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      // Whatever had focus before the dialog opened -- typically the button
      // that triggered it -- gets it back, rather than leaving focus on a
      // now-removed element (which drops it to <body>, disorienting for
      // anyone navigating by keyboard or screen reader).
      restoreFocusTo.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // "cancel" is the browser's own event for the built-in close gesture
    // (Escape, or a form method="dialog" submit) -- prevented here because
    // this component doesn't actually unmount itself; it tells the caller
    // to, the same way the close button and backdrop click below do.
    function onCancel(event: Event) {
      event.preventDefault();
      onClose();
    }
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop click is a mouse-only convenience; Escape (native "cancel") and the close button already give keyboard access
    <dialog
      ref={dialogRef}
      className="child-detail-panel"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : "Dialog"}
      // A click that lands on the <dialog> element itself, not something
      // inside it, is a click on the backdrop -- showModal()'s own
      // hit-testing is what makes that distinction meaningful; this just
      // reads it.
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      <button className="child-detail-close" onClick={onClose} aria-label="Close">×</button>
      {title && <h2 id={titleId}>{title}</h2>}
      {children}
    </dialog>
  );
}
