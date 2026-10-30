// SitStay service worker: shows feeding reminders sent from Supabase.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || "SitStay", {
      body: data.body || "Bort needs you.",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: data.tag || "sitstay",
      data: { url: self.registration.scope },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if (c.url.startsWith(target) && "focus" in c) return c.focus();
      return self.clients.openWindow(target);
    }),
  );
});
