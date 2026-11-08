"use client";

import { useEffect } from "react";
import { initToaster } from "../lib/toaster";

/** Mounts the big confirmation banners (see lib/toaster.ts). Renders nothing itself. */
export default function Toaster() {
  useEffect(() => initToaster(), []);
  return null;
}
