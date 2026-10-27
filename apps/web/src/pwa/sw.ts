/// <reference lib="webworker" />
/**
 * Service worker: precaches the built app so the shell opens offline. A new version waits
 * until the app asks it to take over (the update toast); push events arrive with chunk 1.13.
 */

import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// registerType "prompt": the app posts SKIP_WAITING when the user taps Refresh.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING")
    void self.skipWaiting();
});
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Every in-app URL serves the shell; the router takes it from there.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

// Look fonts (and their small CSS chunks) are out of the precache; keep each one after its first
// download so a look someone picked still has its type offline. Same-origin, hashed names only.
const LOOK_ASSETS = "look-fonts-v1";
registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    url.pathname.startsWith("/assets/") &&
    (request.destination === "font" || /-latin-\d+.*\.css$/.test(url.pathname)),
  async ({ request }) => {
    const cache = await caches.open(LOOK_ASSETS);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  },
);

// Push (chunk 1.13): the payload is a fixed title, a generic label and a tag. Never an amount.
self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; tag?: string; url?: string } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Qash", {
      body: data.body ?? "Open the app to see what's new.",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => "focus" in c);
      if (open) {
        void open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
