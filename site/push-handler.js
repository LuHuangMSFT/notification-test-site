import { validatePushPayload, notificationOptions, TAG_PREFIX, LAB_VERSION } from "./shared.js";
import { errorDetails } from "./diagnostics.js";

export async function handlePush(event, registration, record, publish) {
  let payload;
  try {
    payload = validatePushPayload(event.data?.json());
  } catch {
    await record("push-error", { message: "Missing or invalid push payload." }, "error");
    throw new Error("Missing or invalid push payload.");
  }
  await displayNotification(payload, registration, record, publish, "push");
}

export async function handleMessage(event, registration, record, publish) {
  const port = event.ports[0];
  try {
    if (!event.source?.url?.startsWith(registration.scope)) {
      throw new Error("Notification requests must come from this site's page.");
    }
    let payload;
    try { payload = validatePushPayload(event.data.payload); } catch {
      throw new Error("Missing or invalid worker notification request.");
    }
    await displayNotification(payload, registration, record, publish, "worker");
    port?.postMessage({ ok: true, id: payload.id, version: LAB_VERSION });
  } catch (error) {
    port?.postMessage({ ok: false, id: event.data.payload?.id, error: errorDetails(error) });
    throw error;
  } finally {
    port?.close();
  }
}

async function displayNotification(payload, registration, record, publish, path) {
  // Diagnostic storage must not prevent a visible notification.
  let diagnosticError;
  try {
    await record(`${path}-received`, { id: payload.id, sentAt: payload.sentAt });
    await record(`${path}-display-requested`, { id: payload.id, title: payload.title,
      requireInteraction: payload.requireInteraction, scope: registration.scope });
  } catch (error) {
    diagnosticError = error;
    await publish({ type: "lab-error", message: errorDetails(error).message });
  }
  try {
    const options = notificationOptions(payload, registration.scope);
    options.data.path = path;
    await registration.showNotification(payload.title, options);
  } catch (error) {
    await record(`${path}-display-error`, { id: payload.id, error: errorDetails(error) }, "error");
    throw error;
  }
  await record(`${path}-show-resolved`, { id: payload.id, title: payload.title,
    requireInteraction: payload.requireInteraction });
  await publish({ type: "lab-events-updated" });
  if (diagnosticError) throw diagnosticError;
}

export async function handleClick(event, registration, clients, record) {
  if (!event.notification.tag.startsWith(TAG_PREFIX)) return;
  event.notification.close();
  const url = new URL("./", registration.scope).href;
  const path = event.notification.data?.path === "worker" ? "worker" : "push";
  await record(`${path}-clicked`, { id: event.notification.data?.id });
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find(client =>
    client.url === url || client.url.startsWith(`${url}?`) || client.url.startsWith(`${url}#`));
  if (existing) await existing.focus();
  else await clients.openWindow(url);
}
