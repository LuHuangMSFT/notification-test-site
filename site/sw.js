import { recordDiagnostic, errorDetails, installErrorHandlers } from "./diagnostics.js";
import { handlePush, handleClick } from "./push-handler.js";

async function publish(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (client.url.startsWith(self.registration.scope)) client.postMessage(message);
  }
}

async function reportError(error, stage, details = {}) {
  const diagnostic = errorDetails(error);
  await recordDiagnostic(stage, { ...details, error: diagnostic, scope: self.registration.scope }, "error");
  await publish({ type: "lab-error", message: diagnostic.message });
}

async function run(stage, callback) {
  try {
    await callback();
  } catch (error) {
    await reportError(error, `${stage}-error`);
    throw new Error(errorDetails(error).message);
  }
}

installErrorHandlers(reportError);
self.addEventListener("install", event => event.waitUntil(run("worker-install", async () => {
  await recordDiagnostic("worker-install-started", { scope: self.registration.scope });
  await self.skipWaiting();
  await recordDiagnostic("worker-install-completed");
})));
self.addEventListener("activate", event => event.waitUntil(run("worker-activate", async () => {
  await recordDiagnostic("worker-activate-started");
  await self.clients.claim();
  await recordDiagnostic("worker-activate-completed", { scope: self.registration.scope });
})));
self.addEventListener("push", event => {
  event.waitUntil(run("worker-push", async () => {
    await recordDiagnostic("push-event", { hasData: !!event.data, scope: self.registration.scope });
    await handlePush(event, self.registration, recordDiagnostic, publish);
  }));
});
self.addEventListener("notificationclick", event => {
  event.waitUntil(run("worker-click", () =>
    handleClick(event, self.registration, self.clients, recordDiagnostic)));
});
self.addEventListener("notificationclose", event => {
  event.waitUntil(run("worker-close", () => recordDiagnostic("push-closed", { id: event.notification.data?.id })
    .then(() => publish({ type: "lab-events-updated" }))));
});
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil(run("worker-subscription-change", () => recordDiagnostic("subscription-changed", {
    message: "Subscribe again and replace WEB_PUSH_SUBSCRIPTION in Actions secrets.",
  }, "warn").then(() => publish({ type: "lab-events-updated" }))));
});
