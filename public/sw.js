/* Veritas Village service worker.
 *
 * Deliberately does one job: show push notifications and send a tap to the
 * right page. It does NOT cache pages or intercept fetches -- the portal is
 * server-rendered and signed-in, and a cache here could keep serving a stale
 * build or another person's page after a deploy or sign-out. Offline support
 * can be added later on purpose; it should not arrive by accident.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Veritas Village";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "/brand/icon-192.png",
    badge: "/brand/favicon-96.png",
    tag: data.tag || undefined,
    // An urgent alert stays on screen until it is dealt with, and buzzes again if it replaces an earlier one.
    requireInteraction: data.urgent === true,
    renotify: data.urgent === true && Boolean(data.tag),
    vibrate: data.urgent === true ? [300, 150, 300, 150, 300] : undefined,
    data: { url: data.url || "/family-village/home" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only ever follow same-origin paths, whatever the payload said.
  const raw = (event.notification.data && event.notification.data.url) || "/family-village/home";
  const target = new URL(raw, self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/family-village/home";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
