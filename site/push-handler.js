import { validatePushPayload, notificationOptions, TAG_PREFIX } from "./shared.js";

export async function handlePush(event, registration, record, publish) {
  let payload;
  try {
    payload = validatePushPayload(event.data?.json());
  } catch {
    await record("push-error", { message: "Missing or invalid push payload." });
    throw new Error("Missing or invalid push payload.");
  }
  // Diagnostic storage must not prevent a visible notification.
  let diagnosticError;
  try {
    await record("push-received", { id: payload.id, sentAt: payload.sentAt });
  } catch (error) {
    diagnosticError = error;
    await publish({ type: "lab-error", message: error.message });
  }
  try {
    await registration.showNotification(payload.title,
      notificationOptions(payload, registration.scope));
  } catch (error) {
    await record("push-display-error", { id: payload.id, message: error.message });
    throw error;
  }
  await record("push-show-resolved", { id: payload.id, title: payload.title,
    requireInteraction: payload.requireInteraction });
  await publish({ type: "lab-events-updated" });
  if (diagnosticError) throw diagnosticError;
}

export async function handleClick(event, registration, clients, record) {
  if (!event.notification.tag.startsWith(TAG_PREFIX)) return;
  event.notification.close();
  const url = new URL("./", registration.scope).href;
  await record("push-clicked", { id: event.notification.data?.id });
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find(client =>
    client.url === url || client.url.startsWith(`${url}?`) || client.url.startsWith(`${url}#`));
  if (existing) await existing.focus();
  else await clients.openWindow(url);
}
