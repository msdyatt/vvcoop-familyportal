"use client";

import { useEffect } from "react";
import { startNativeSession } from "../../lib/native-session";

/** Lets the iPhone app's native screens use this person's session (lib/native-session.ts). Renders nothing. */
export default function NativeSessionReporter() {
  useEffect(() => startNativeSession(), []);
  return null;
}
