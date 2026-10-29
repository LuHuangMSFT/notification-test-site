import { parseDelay, decodePublicKey, notificationOptions, TAG_PREFIX } from "./shared.js";
import { recordEvent, readEvents, clearEvents } from "./store.js";

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
  };
}

function fail(error) {
  $("error").textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}

async function showLog() {
  $("log").textContent = JSON.stringify(await readEvents(), null, 2);
}

async function record(event, details = {}) {
  await recordEvent(event, { ...state(), ...details });
  await showLog();
}

function action(id, callback) {
  $(id).addEventListener("click", async () => {
    $("error").textContent = "";
    $(id).disabled = true;
    try {
      await callback();
    } catch (error) {
      fail(error);
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
    "Web app manifests": String(document.querySelectorAll('link[rel="manifest"]').length),
    "Page URL": location.href,
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

async function sendTab(persistent) {
  if (Notification.permission !== "granted") throw new Error("Allow notifications first.");
  const id = `tab-${crypto.randomUUID()}`;
  const payload = {
    id, sentAt: new Date().toISOString(), title: `SAA tab ${id.slice(-8)}`,
    body: "Tab-dependent notification. This document was open when it fired.",
    requireInteraction: persistent,
  };
  await record("tab-requested", { id, title: payload.title, requireInteraction: persistent });
  const notification = new Notification(payload.title, notificationOptions(payload, baseURL));
  notifications.add(notification);
  for (const event of ["show", "error", "click", "close"]) {
    notification.addEventListener(event, () => {
      if (event === "close") notifications.delete(notification);
      if (event === "error") fail(new Error("The document notification emitted an error event."));
      record(`tab-${event}`, { id }).catch(fail);
    });
  }
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
  const id = crypto.randomUUID();
  await record("tab-scheduled", { id, delaySeconds: delay });
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    try { await sendTab(persistent); await refresh(); } catch (error) { fail(error); }
  }, delay * 1000));
});
action("tab-cancel", async () => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  await record("tab-timers-canceled");
});
action("subscribe", async () => {
  if (Notification.permission !== "granted") throw new Error("Allow notifications first.");
  const applicationServerKey = decodePublicKey(config.vapidPublicKey);
  const worker = await navigator.serviceWorker.register(new URL("sw.js", baseURL), {
    scope: baseURL.href, type: "module", updateViaCache: "none",
  });
  await waitForActivation(worker);
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
action("export", async () => download("notification-test-events.json",
  JSON.stringify({ url: location.href, userAgent: navigator.userAgent,
    state: state(), events: await readEvents() }, null, 2)));
action("clear-log", clearEvents);
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

for (const event of ["focus", "blur", "visibilitychange"]) {
  window.addEventListener(event, () => record(event).then(refresh).catch(fail));
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
}

async function start() {
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
  for (const id of ["permission", "refresh", "export", "clear-notifications", "clear-log"]) {
    $(id).disabled = false;
  }
  await record("page-opened", { url: location.href });
  await refresh();
  $("notice").textContent = "Ready. Choose a notification path above.";
}
start().catch(fail);
