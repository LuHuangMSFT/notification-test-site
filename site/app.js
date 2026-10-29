import { parseDelay, decodePublicKey, notificationOptions, TAG_PREFIX, LAB_VERSION } from "./shared.js";
import {
  contextId, recordDiagnostic, readDiagnostics, clearDiagnostics, errorDetails,
  diagnosticURL, printDiagnostics, installErrorHandlers,
} from "./diagnostics.js";

const $ = id => document.getElementById(id);
const modes = ["browser", "minimal-ui", "standalone", "fullscreen", "window-controls-overlay"];
const timers = new Map();
const notifications = new Set();
const baseURL = new URL("./", location.href);
let config;
let subscription;

function state() {
  return {
    displayMode: modes.find(mode => matchMedia(`(display-mode: ${mode})`).matches) || "unknown",
    permission: "Notification" in window ? Notification.permission : "unsupported",
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
  };
}

async function fail(error, stage = "page-error", details = {}) {
  const diagnostic = errorDetails(error);
  $("error").textContent = diagnostic.message;
  await record(stage, { ...details, error: diagnostic }, "error");
}

async function showLog() {
  const diagnostics = await readDiagnostics();
  $("log").textContent = JSON.stringify(diagnostics.events, null, 2);
  $("storage-warning").textContent = diagnostics.storage.error ? diagnostics.storage.note : "";
}

async function record(event, details = {}, level = "info") {
  await recordDiagnostic(event, { ...state(), ...details }, level);
  await showLog();
}

function action(id, callback) {
  $(id).addEventListener("click", async () => {
    const actionId = crypto.randomUUID();
    const trace = id !== "clear-log";
    $("error").textContent = "";
    $(id).disabled = true;
    try {
      if (trace) void record("action-started", { action: id, actionId });
      await callback();
      if (trace) await record("action-completed", { action: id, actionId });
    } catch (error) {
      await fail(error, "action-error", { action: id, actionId });
    } finally {
      $(id).disabled = false;
      try { await refresh(); } catch (error) { fail(error); }
    }
  });
}

async function registration() {
  if (!("serviceWorker" in navigator)) return undefined;
  const worker = await navigator.serviceWorker.getRegistration(baseURL.href);
  return worker?.scope === baseURL.href ? worker : undefined;
}

async function refresh() {
  const current = state();
  const values = {
    "Secure context": String(isSecureContext),
    "Notification permission": current.permission,
    "Display mode": current.displayMode,
    "Page visibility": `${current.visibility}; focused: ${current.focused}`,
    "Browser online hint": String(current.online),
    "Lab version": LAB_VERSION,
    "Web app manifests": String(document.querySelectorAll('link[rel="manifest"]').length),
    "Page URL": diagnosticURL(location.href),
  };
  $("environment").replaceChildren(...Object.entries(values).flatMap(([name, value]) => {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = name;
    description.textContent = value;
    return [term, description];
  }));
  const worker = await registration();
  subscription = worker ? await worker.pushManager.getSubscription() : null;
  $("push-status").textContent = subscription
    ? `Subscribed. Worker scope: ${worker.scope}. The Actions secret must match this browser.`
    : worker ? "Not subscribed. The test service worker remains registered."
      : "Not subscribed. No push worker is registered until you subscribe.";
  $("download").disabled = !subscription;
  $("unsubscribe").disabled = !subscription;
  $("subscribe").disabled = !isSecureContext || !("PushManager" in window) || !!subscription;
  $("tab-now").disabled = current.permission !== "granted";
  $("tab-schedule").disabled = current.permission !== "granted";
  $("tab-cancel").disabled = !timers.size;
  $("tab-status").textContent = timers.size
    ? `${timers.size} pending timer(s). Keep this document open.`
    : "No pending timers.";
  await showLog();
}

function download(filename, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function sendTab(persistent, id = `tab-${crypto.randomUUID()}`) {
  if (Notification.permission !== "granted") throw new Error("Allow notifications first.");
  const payload = {
    id, sentAt: new Date().toISOString(), title: `SAA tab ${id.slice(-8)}`,
    body: "Tab-dependent notification. This document was open when it fired.",
    requireInteraction: persistent,
  };
  await record("tab-requested", { id, title: payload.title, requireInteraction: persistent });
  let notification;
  try {
    notification = new Notification(payload.title, notificationOptions(payload, baseURL));
  } catch (error) {
    await record("tab-create-error", { id, error: errorDetails(error) }, "error");
    throw error;
  }
  notifications.add(notification);
  for (const event of ["show", "error", "click", "close"]) {
    notification.addEventListener(event, () => {
      if (event === "close") notifications.delete(notification);
      if (event === "error") {
        void fail(new Error("The document notification emitted an error event."), "tab-error", { id });
      } else {
        record(`tab-${event}`, { id }).catch(fail);
      }
    });
  }
  await record("tab-created", { id });
}

function waitForActivation(worker) {
  if (worker.active?.state === "activated") return Promise.resolve();
  const candidate = worker.installing || worker.waiting || worker.active;
  if (!candidate) return Promise.reject(new Error("No service worker is available."));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Service worker activation timed out.")), 15000);
    function finish(error) {
      clearTimeout(timeout);
      candidate.removeEventListener("statechange", check);
      if (error) reject(error); else resolve();
    }
    function check() {
      void record("worker-state-changed", {
        scriptURL: diagnosticURL(candidate.scriptURL), workerState: candidate.state,
      });
      if (candidate.state === "activated") finish();
      else if (candidate.state === "redundant") finish(new Error("Service worker became redundant."));
    }
    candidate.addEventListener("statechange", check);
    check();
  });
}

action("permission", async () => {
  if (!isSecureContext || !("Notification" in window)) {
    throw new Error("Notifications require a supported browser and HTTPS (or localhost).");
  }
  void record("permission-requested");
  const permission = await Notification.requestPermission();
  await record("permission-result", { permission });
  if (permission !== "granted") {
    throw new Error("Permission was not granted. Check this site's notification setting.");
  }
  $("notice").textContent = "Notification permission granted.";
});
action("refresh", refresh);
action("tab-now", () => sendTab($("tab-persistent").checked));
action("tab-schedule", async () => {
  const delay = parseDelay($("tab-delay").value);
  const persistent = $("tab-persistent").checked;
  const id = `tab-${crypto.randomUUID()}`;
  const dueAt = Date.now() + delay * 1000;
  await record("tab-scheduled", { id, delaySeconds: delay, dueAt: new Date(dueAt).toISOString(),
    requireInteraction: persistent });
  const handle = setTimeout(async () => {
    timers.delete(id);
    try {
      await record("tab-timer-fired", { id, dueAt: new Date(dueAt).toISOString(),
        driftMs: Date.now() - dueAt });
      await sendTab(persistent, id);
      await refresh();
    } catch (error) { await fail(error, "tab-timer-error", { id }); }
  }, delay * 1000);
  timers.set(id, { handle, dueAt, delaySeconds: delay });
});
action("tab-cancel", async () => {
  const ids = [...timers.keys()];
  for (const timer of timers.values()) clearTimeout(timer.handle);
  timers.clear();
  await record("tab-timers-canceled", { ids });
});
action("subscribe", async () => {
  if (Notification.permission !== "granted") throw new Error("Allow notifications first.");
  const applicationServerKey = decodePublicKey(config.vapidPublicKey);
  await record("worker-registration-started", { scope: baseURL.href });
  const worker = await navigator.serviceWorker.register(new URL("sw.js", baseURL), {
    scope: baseURL.href, type: "module", updateViaCache: "none",
  });
  await record("worker-registered", { scope: worker.scope });
  await waitForActivation(worker);
  await record("worker-activated", { scope: worker.scope });
  await record("push-subscription-started");
  subscription = await worker.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey,
  });
  await record("push-subscribed", { scope: worker.scope });
  $("notice").textContent = "Subscribed. Download the private subscription and register the Actions secret.";
});
action("download", () => {
  if (!subscription) throw new Error("Subscribe this browser first.");
  download("notification-test-subscription.json", JSON.stringify(subscription.toJSON(), null, 2));
  $("notice").textContent = "Private subscription downloaded. Do not share it publicly.";
});
action("unsubscribe", async () => {
  if (!subscription || !await subscription.unsubscribe()) throw new Error("Unsubscribe did not succeed.");
  await record("push-unsubscribed");
  $("notice").textContent = "Unsubscribed. Remove or replace WEB_PUSH_SUBSCRIPTION in Actions secrets too.";
});
function workerState(worker) {
  return worker ? { scriptURL: diagnosticURL(worker.scriptURL), state: worker.state } : null;
}

async function diagnosticReport() {
  let worker = null;
  let workerError = null;
  try {
    const registered = await registration();
    const subscribed = registered ? await registered.pushManager.getSubscription() : null;
    worker = registered ? {
      scope: registered.scope, installing: workerState(registered.installing),
      waiting: workerState(registered.waiting), active: workerState(registered.active),
      subscribed: !!subscribed, expirationTime: subscribed?.expirationTime ?? null,
    } : null;
  } catch (error) {
    workerError = errorDetails(error);
    await record("diagnostic-snapshot-error", { error: workerError }, "error");
  }
  return {
    schemaVersion: 1, version: LAB_VERSION, collectedAt: new Date().toISOString(), contextId,
    environment: {
      url: diagnosticURL(location.href), userAgent: navigator.userAgent, platform: navigator.platform,
      secureContext: isSecureContext, timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      ...state(), manifestCount: document.querySelectorAll('link[rel="manifest"]').length,
      supported: {
        notifications: "Notification" in window, serviceWorker: "serviceWorker" in navigator,
        push: "PushManager" in window, indexedDB: "indexedDB" in window,
      },
    },
    worker, workerError, controller: workerState(navigator.serviceWorker?.controller),
    pendingTimers: [...timers].map(([id, timer]) => ({
      id, dueAt: new Date(timer.dueAt).toISOString(), delaySeconds: timer.delaySeconds,
    })),
    limitations: [
      "API success does not prove a Windows banner or Notification Center entry.",
      "The site cannot read Do Not Disturb, OS notification settings, or enterprise policies.",
      "No push-received event does not distinguish an unsent push from transport or browser delivery failure; compare sender logs.",
      "Only the latest local events are retained; missing events are not proof that an action never happened.",
    ],
    ...await readDiagnostics(),
  };
}

action("export", async () => {
  download("notification-test-diagnostics.json", JSON.stringify(await diagnosticReport(), null, 2));
  $("notice").textContent = "Diagnostic report downloaded. Review it before sharing; do not share the private subscription file.";
});
action("console-log", async () => {
  printDiagnostics(await diagnosticReport());
  $("notice").textContent = "Saved page and worker events printed to this page's DevTools Console. Filter for Notification Lab.";
});
action("clear-log", clearDiagnostics);
action("clear-notifications", async () => {
  for (const notification of notifications) notification.close();
  notifications.clear();
  const worker = await registration();
  if (worker) {
    for (const notification of await worker.getNotifications()) {
      if (notification.tag.startsWith(TAG_PREFIX)) notification.close();
    }
  }
  $("notice").textContent = "Closed retained document and worker test notifications. Older document notifications may need individual dismissal in Notification Center.";
});

installErrorHandlers(fail);
for (const event of ["focus", "blur", "visibilitychange", "online", "offline"]) {
  window.addEventListener(event, () => record(event).then(refresh).catch(fail));
}
for (const event of ["pageshow", "pagehide"]) {
  window.addEventListener(event, e => {
    void record(event, { persisted: e.persisted, pendingTimerIds: [...timers.keys()] });
  });
}
for (const mode of modes) {
  matchMedia(`(display-mode: ${mode})`).addEventListener("change",
    () => record("display-mode-change").then(refresh).catch(fail));
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type === "lab-events-updated") refresh().catch(fail);
    else if (event.data?.type === "lab-error") fail(new Error(event.data.message));
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    record("worker-controller-changed", { controller: workerState(navigator.serviceWorker.controller) })
      .then(refresh).catch(fail);
  });
}

async function start() {
  for (const id of ["export", "console-log", "clear-log"]) $(id).disabled = false;
  await record("page-opened", { url: diagnosticURL(location.href), userAgent: navigator.userAgent,
    secureContext: isSecureContext });
  await record("configuration-requested");
  const response = await fetch(new URL("config.json", baseURL), { cache: "no-store" });
  if (!response.ok) throw new Error(`Cannot load site configuration (HTTP ${response.status}).`);
  config = await response.json();
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) throw new Error("Invalid repository configuration.");
  const repoURL = `https://github.com/${config.repository}`;
  $("actions").href = `${repoURL}/actions/workflows/send-push.yml`;
  $("secrets").href = `${repoURL}/settings/secrets/actions`;
  $("source").href = repoURL;
  $("secret-command").textContent =
    `Get-Content .\\notification-test-subscription.json -Raw |\n  gh secret set WEB_PUSH_SUBSCRIPTION --repo ${config.repository}`;
  await record("configuration-loaded");
  if (navigator.permissions) {
    try {
      const permission = await navigator.permissions.query({ name: "notifications" });
      permission.addEventListener("change", () => {
        record("permission-changed", { permissionState: permission.state }).then(refresh).catch(fail);
      });
    } catch (error) {
      await record("permission-observer-error", { error: errorDetails(error) }, "warn");
    }
  }
  for (const id of ["permission", "refresh", "clear-notifications"]) {
    $(id).disabled = false;
  }
  await refresh();
  $("notice").textContent = "Ready. Choose a notification path above.";
}
start().catch(error => fail(error, "startup-error"));
