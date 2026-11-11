"use client";

import { useEffect } from "react";
import { initSwipeBack } from "../lib/swipe-back";

/** Mounts the edge-swipe-back gesture for the installed web app (see lib/swipe-back.ts). Renders nothing. */
export default function SwipeBack() {
  useEffect(() => initSwipeBack(), []);
  return null;
}
