"use client";

import { useEffect } from "react";
import { messagingPlugin, nativePlatform, safeAppPath } from "../lib/native";
import { refreshNativeToken } from "../lib/push";

/**
 * Inside the iOS/Android app only: opens the right page when someone taps a
 * notification, and keeps this phone's token registered when Firebase rotates
 * it. Renders nothing, and does nothing in a browser.
 */
export default function NativePushRouter() {
  useEffect(() => {
    if (!nativePlatform()) return;
    const plugin = messagingPlugin();
    if (!plugin) return;
    void plugin.addListener("notificationActionPerformed", (event) => {
      window.location.assign(safeAppPath(event.notification?.data?.url));
    });
    void plugin.addListener("tokenReceived", (event) => { void refreshNativeToken(event.token); });
  }, []);
  return null;
}
