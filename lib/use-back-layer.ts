import { useEffect, useRef } from "react";
import { pushBackLayer } from "./back-layers";

/** While `active`, Back (button or swipe) calls `close` instead of leaving the page. See lib/back-layers.ts. */
export function useBackLayer(active: boolean, close: () => void) {
  const latest = useRef(close);
  useEffect(() => { latest.current = close; });

  useEffect(() => {
    if (!active) return;
    return pushBackLayer(() => latest.current());
  }, [active]);
}
