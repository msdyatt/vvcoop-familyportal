"use client";

import { RefObject, useEffect } from "react";

/**
 * Calls `onOutside` when a pointer press lands outside `ref`.
 *
 * Both the account menu in AppHeader and the workspace switcher in PortalNav
 * had their own identical copy of this effect.
 */
export function useOutsideClick(ref: RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  });
}
