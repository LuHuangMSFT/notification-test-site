import { recordEvent } from "./store.js";
import { handlePush, handleClick } from "./push-handler.js";

async function publish(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage(message);
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  event.waitUntil(handlePush(event, self.registration, recordEvent, publish));
});
self.addEventListener("notificationclick", event => {
  event.waitUntil(handleClick(event, self.registration, self.clients, recordEvent));
});
self.addEventListener("notificationclose", event => {
  event.waitUntil(recordEvent("push-closed", { id: event.notification.data?.id })
    .then(() => publish({ type: "lab-events-updated" })));
});
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil(recordEvent("subscription-changed", {
    message: "Subscribe again and replace WEB_PUSH_SUBSCRIPTION in Actions secrets.",
  }).then(() => publish({ type: "lab-events-updated" })));
});
