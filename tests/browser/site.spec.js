import { test, expect } from "@playwright/test";
import { MAX_EVENTS, LAB_VERSION } from "../../site/shared.js";

async function downloadReport(page) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download diagnostic report", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("notification-test-diagnostics.json");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("plain-site load does not install a worker or declare a manifest", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByText("Ready. Choose a notification path above.")).toBeVisible();
  expect(await page.locator('link[rel="manifest"]').count()).toBe(0);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect(page.locator("#environment")).toContainText("browser");
  await expect(page.locator("#environment")).toContainText("true");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#advanced-push")).not.toHaveAttribute("open");
  await expect(page.locator("#subscribe")).not.toBeVisible();
  await expect(page.locator("#worker-now")).toBeVisible();
  expect((await page.request.get("./manifest.json")).status()).toBe(404);
});

test("real document Notification API records a request with granted permission", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.goto("./");
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await page.getByRole("button", { name: "Send tab notification now", exact: true }).click();
  await expect(page.locator("#log")).toContainText("tab-requested");
  await expect(page.locator("#error")).toBeEmpty();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test("tab timer can be canceled and closing the document stops its pending callback", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.clock.install();
  await page.goto("./");
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await page.getByRole("button", { name: "Schedule tab notification", exact: true }).click();
  await expect(page.locator("#tab-status")).toContainText("1 pending");
  await page.getByRole("button", { name: "Cancel pending tab notifications", exact: true }).click();
  await page.clock.fastForward(11000);
  await expect(page.locator("#tab-status")).toContainText("No pending");
  await expect(page.locator("#log")).not.toContainText("tab-requested");
  await page.getByRole("button", { name: "Schedule tab notification", exact: true }).click();
  await expect(page.locator("#tab-status")).toContainText("1 pending");
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("./");
  await expect(reopened.locator("#log")).not.toContainText("tab-requested");
});

test("delayed tab callback fires and captures current visibility", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.clock.install();
  await page.goto("./");
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await page.getByRole("button", { name: "Schedule tab notification", exact: true }).click();
  await expect(page.locator("#tab-status")).toContainText("1 pending");
  await page.clock.fastForward(11000);
  await expect(page.locator("#log")).toContainText("tab-requested");
  await expect(page.locator("#tab-status")).toContainText("No pending");
  const events = await page.evaluate(async () => (await import("./diagnostics.js")).readDiagnostics());
  const scheduled = events.events.find(event => event.event === "tab-scheduled");
  expect(events.events.find(event => event.event === "tab-timer-fired").id).toBe(scheduled.id);
  expect(events.events.find(event => event.event === "tab-created").id).toBe(scheduled.id);
});

test("project-scoped worker activates and event storage remains bounded and durable", async ({ page }) => {
  await page.goto("./");
  const result = await page.evaluate(async limit => {
    const worker = await navigator.serviceWorker.register("./sw.js", { type: "module" });
    await navigator.serviceWorker.ready;
    const store = await import("./store.js");
    for (let i = 0; i < limit + 5; i++) await store.recordEvent("bounded-test", { index: i });
    return { scope: worker.scope, events: await store.readEvents() };
  }, MAX_EVENTS);
  expect(result.scope).toBe("http://localhost:8769/notification-test-site/");
  expect(result.events).toHaveLength(MAX_EVENTS);
  expect(result.events[0].index).toBe(MAX_EVENTS + 4);
  await page.reload();
  await expect(page.locator("#log")).toContainText("bounded-test");
  await page.getByRole("button", { name: "Clear local event log", exact: true }).click();
  await expect(page.locator("#log")).toHaveText("[]");
});

test("subscription requires explicit permission; no credentials appear in logs", async ({ page }) => {
  await page.goto("./");
  await page.getByText("Optional: real Web Push (advanced)", { exact: true }).click();
  await page.getByRole("button", { name: "Subscribe this browser to push", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Allow notifications first.");
  await expect(page.locator("#log")).not.toContainText("endpoint");
  await expect(page.locator("#log")).not.toContainText("p256dh");
  await expect(page.locator("#log")).not.toContainText("VAPID_PRIVATE_KEY");
});

test("a broader homepage worker is never treated as this project's subscription", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.serviceWorker.getRegistration = async () => ({
      scope: new URL("/", location.href).href,
      pushManager: {
        getSubscription() { throw new Error("Unrelated homepage subscription was accessed"); },
      },
    });
  });
  await page.goto("./");
  await expect(page.getByText("Ready. Choose a notification path above.")).toBeVisible();
  await page.getByText("Optional: real Web Push (advanced)", { exact: true }).click();
  await expect(page.locator("#push-status")).toContainText("Not subscribed.");
  await expect(page.locator("#unsubscribe")).toBeDisabled();
  await expect(page.locator("#error")).toBeEmpty();
});

test("console traces and exported diagnostics correlate actual document notifications without URL credentials",
  async ({ page, context }) => {
    const consoleLines = [];
    page.on("console", message => consoleLines.push(message.text()));
    await context.grantPermissions(["notifications"]);
    await page.goto("./?token=private-query#private-fragment");
    await page.getByRole("button", { name: "Send tab notification now", exact: true }).click();
    await expect(page.locator("#log")).toContainText("tab-created");
    const report = await downloadReport(page);
    expect(report.version).toBe(LAB_VERSION);
    expect(report.schemaVersion).toBe(1);
    expect(report.environment).toMatchObject({
      permission: "granted", displayMode: "browser", secureContext: true, manifestCount: 0,
    });
    expect(report.environment.userAgent).toBeTruthy();
    expect(report.storage.error).toBeNull();
    expect(report.worker).toBeNull();
    const requested = report.events.find(event => event.event === "tab-requested");
    const created = report.events.find(event => event.event === "tab-created");
    expect(created.id).toBe(requested.id);
    expect(created).toMatchObject({ source: "page", level: "info", version: LAB_VERSION });
    expect(created.eventId).toBeTruthy();
    expect(created.contextId).toBe(report.contextId);
    expect(consoleLines.some(line => line.includes("[Notification Lab]") && line.includes("tab-created"))).toBe(true);
    expect(JSON.stringify({ report, consoleLines })).not.toMatch(/private-query|private-fragment|p256dh/);
  });

test("runtime errors and unhandled rejections persist, redact, and replay into the page console",
  async ({ page }) => {
    const consoleLines = [];
    page.on("console", message => consoleLines.push(message.text()));
    await page.goto("./");
    await expect(page.locator("#notice")).toContainText("Ready.");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("Runtime probe https://fcm.googleapis.com/private-endpoint auth=private-auth"); }, 0);
      void Promise.reject(new Error("Rejection probe p256dh=private-key"));
    });
    await expect(page.locator("#log")).toContainText("runtime-error");
    await expect(page.locator("#log")).toContainText("unhandled-rejection");
    await page.reload();
    const report = await downloadReport(page);
    const runtime = report.events.find(event => event.event === "runtime-error");
    expect(runtime.error.name).toBe("Error");
    expect(runtime.error.message).toContain("Runtime probe");
    expect(runtime.error.stack).toBeTruthy();
    expect(runtime.level).toBe("error");
    expect(report.events.some(event => event.event === "unhandled-rejection")).toBe(true);
    await page.getByRole("button", { name: "Print saved diagnostics to console", exact: true }).click();
    await expect.poll(() => consoleLines.some(line => line.includes("[saved]") && line.includes("runtime-error"))).toBe(true);
    expect(JSON.stringify({ report, consoleLines })).not.toMatch(/private-endpoint|private-auth|private-key/);
  });

test("missing optional push configuration does not block the simple worker test or diagnostic export", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.route("**/config.json", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("./");
  await expect(page.locator("#error")).toContainText("HTTP 503");
  const report = await downloadReport(page);
  expect(report.events.find(event => event.event === "configuration-error").error.message).toContain("HTTP 503");
  expect(report.environment.secureContext).toBe(true);
  await page.getByRole("button", { name: "Send service-worker notification", exact: true }).click();
  await expect(page.locator("#log")).toContainText("worker-acknowledged");
  await page.getByRole("button", { name: "Close this site's test notifications", exact: true }).click();
});

test("failed IndexedDB explicitly falls back to memory without blocking actual notifications or export",
  async ({ page, context }) => {
    await context.grantPermissions(["notifications"]);
    await page.addInitScript(() => {
      indexedDB.open = () => { throw new DOMException("Storage disabled", "SecurityError"); };
    });
    await page.goto("./");
    await expect(page.locator("#notice")).toContainText("Ready.");
    await expect(page.locator("#storage-warning")).toContainText("memory-only");
    await page.getByRole("button", { name: "Send tab notification now", exact: true }).click();
    await expect(page.locator("#log")).toContainText("tab-created");
    const report = await downloadReport(page);
    expect(report.storage.error.name).toBe("SecurityError");
    expect(report.events.some(event => event.event === "diagnostic-storage-error")).toBe(true);
    expect(report.events.some(event => event.event === "tab-created")).toBe(true);
  });

test("permission requests keep the original click's user activation while logging", async ({ page }) => {
  await page.addInitScript(() => {
    Notification.requestPermission = async () => {
      window.permissionHadActivation = navigator.userActivation.isActive;
      return "default";
    };
  });
  await page.goto("./");
  await page.getByRole("button", { name: "Allow notifications", exact: true }).click();
  await expect(page.locator("#log")).toContainText("permission-result");
  expect(await page.evaluate(() => window.permissionHadActivation)).toBe(true);
});

test("a stalled IndexedDB request times out once and leaves diagnostic export usable", async ({ page }) => {
  await page.addInitScript(() => { indexedDB.open = () => ({}); });
  await page.goto("./");
  await expect(page.locator("#notice")).toContainText("Ready.", { timeout: 10000 });
  await expect(page.locator("#log")).toContainText("configuration-loaded");
  const report = await downloadReport(page);
  expect(report.storage.error.message).toContain("timed out");
  expect(report.events.some(event => event.event === "configuration-loaded")).toBe(true);
});

test("legacy logs retain correlation IDs but redact URLs and errors before export or console replay",
  async ({ page }) => {
    const consoleLines = [];
    page.on("console", message => consoleLines.push(message.text()));
    await page.goto("./");
    await expect(page.locator("#notice")).toContainText("Ready.");
    await page.evaluate(async () => {
      const { recordEvent } = await import("./store.js");
      await recordEvent("page-opened", { url: `${location.href}?token=legacy-query#legacy-fragment` });
      await recordEvent("push-display-error", {
        id: "push-11111111-2222-3333-4444-555555555555",
        message: "Failed https://abc.notify.windows.com/legacy-endpoint auth=legacy-auth",
      });
    });
    const report = await downloadReport(page);
    await page.getByRole("button", { name: "Print saved diagnostics to console", exact: true }).click();
    expect(report.events.find(event => event.event === "push-display-error")).toMatchObject({
      source: "legacy", id: "push-11111111-2222-3333-4444-555555555555",
    });
    expect(JSON.stringify({ report, consoleLines })).not.toMatch(/legacy-query|legacy-fragment|legacy-endpoint|legacy-auth/);
  });

test("subscription failures retain the failing stage while diagnostics omit private subscription material",
  async ({ page, context }) => {
    const consoleLines = [];
    page.on("console", message => consoleLines.push(message.text()));
    await context.grantPermissions(["notifications"]);
    await page.addInitScript(() => {
      PushManager.prototype.subscribe = async () => {
        throw new DOMException("Provider refused https://abc.notify.windows.com/private-endpoint auth=private-auth",
          "NotAllowedError");
      };
    });
    await page.goto("./");
    await page.getByText("Optional: real Web Push (advanced)", { exact: true }).click();
    await page.getByRole("button", { name: "Subscribe this browser to push", exact: true }).click();
    await expect(page.locator("#log")).toContainText("push-subscription-started");
    await expect(page.locator("#log")).toContainText("action-error");
    await page.evaluate(() => {
      PushManager.prototype.getSubscription = async () => ({
        endpoint: "https://abc.notify.windows.com/private-endpoint",
        keys: { p256dh: "private-p256dh", auth: "private-auth" },
        expirationTime: null,
      });
    });
    const report = await downloadReport(page);
    expect(report.worker.subscribed).toBe(true);
    expect(report.events.find(event => event.event === "action-error")).toMatchObject({
      action: "subscribe", error: { name: "NotAllowedError" },
    });
    expect(JSON.stringify({ report, consoleLines })).not.toMatch(/private-endpoint|private-auth|private-p256dh/);
  });

test("the simple worker button uses real worker notification APIs without a push subscription",
  async ({ page, context }) => {
    await context.grantPermissions(["notifications"]);
    await page.addInitScript(() => {
      PushManager.prototype.subscribe = () => { throw new Error("The simple test must never subscribe"); };
      PushManager.prototype.getSubscription = () => { throw new Error("The simple test must not need push status"); };
    });
    await page.goto("./");
    await page.locator("#worker-persistent").check();
    await page.getByRole("button", { name: "Send service-worker notification", exact: true }).click();
    await expect(page.locator("#log")).toContainText("worker-acknowledged");
    await expect(page.locator("#error")).toBeEmpty();
    const worker = context.serviceWorkers()[0];
    const notification = await worker.evaluate(async () => {
      const notifications = await self.registration.getNotifications();
      return { title: notifications[0].title, data: notifications[0].data,
        requireInteraction: notifications[0].requireInteraction,
        subscribed: !!await self.registration.pushManager.getSubscription() };
    });
    expect(notification).toMatchObject({
      title: expect.stringMatching(/^SAA worker /), data: { path: "worker" },
      requireInteraction: true, subscribed: false,
    });
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto("./");
    const report = await downloadReport(reopened);
    expect(report.worker.subscribed).toBe(false);
    for (const event of ["worker-requested", "worker-received", "worker-display-requested",
      "worker-show-resolved", "worker-acknowledged"]) {
      expect(report.events.find(entry => entry.event === event).id).toBe(notification.data.id);
    }
    expect(report.events.find(entry => entry.event === "worker-show-resolved").source).toBe("worker");
    expect(report.events.some(entry => entry.event === "push-received" || entry.event === "push-subscribed")).toBe(false);
    expect(await worker.evaluate(async () => (await self.registration.getNotifications()).length)).toBe(1);
    await reopened.getByRole("button", { name: "Close this site's test notifications", exact: true }).click();
  });

test("an older active worker is upgraded before the one-click notification is sent", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.goto("./");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("./sw.js?fixture=old-worker", { type: "module", scope: "./" });
    await navigator.serviceWorker.ready;
  });
  expect(await context.serviceWorkers()[0].evaluate(() => self.testOldWorker)).toBe(true);
  await page.getByRole("button", { name: "Send service-worker notification", exact: true }).click();
  await expect(page.locator("#log")).toContainText("worker-acknowledged");
  const report = await downloadReport(page);
  expect(report.events.find(event => event.event === "worker-acknowledged").workerVersion).toBe(LAB_VERSION);
  await page.getByRole("button", { name: "Close this site's test notifications", exact: true }).click();
});

test("worker display rejection reaches the page and diagnostic report without a success response",
  async ({ page, context }) => {
    await context.grantPermissions(["notifications"]);
    await page.goto("./");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("./sw.js", { type: "module" });
      await navigator.serviceWorker.ready;
    });
    await context.serviceWorkers()[0].evaluate(() => {
      self.registration.showNotification = async () => {
        throw new DOMException("Synthetic worker display denied", "NotAllowedError");
      };
    });
    await page.getByRole("button", { name: "Send service-worker notification", exact: true }).click();
    await expect(page.locator("#error")).toContainText("Synthetic worker display denied");
    const report = await downloadReport(page);
    const failed = report.events.find(event => event.event === "worker-display-error");
    expect(failed.error.name).toBe("NotAllowedError");
    expect(report.events.find(event => event.event === "worker-send-error").id).toBe(failed.id);
    expect(report.events.some(event => event.event === "worker-acknowledged")).toBe(false);
  });

test("missing worker responses time out explicitly instead of claiming success", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.clock.install();
  await page.addInitScript(() => {
    ServiceWorker.prototype.postMessage = () => { window.workerMessageDropped = true; };
  });
  await page.goto("./");
  await page.getByRole("button", { name: "Send service-worker notification", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.workerMessageDropped)).toBe(true);
  await expect(page.locator("#worker-now")).toBeDisabled();
  await page.clock.fastForward(16000);
  await expect(page.locator("#error")).toContainText("did not confirm");
  const report = await downloadReport(page);
  expect(report.events.some(event => event.event === "worker-send-error")).toBe(true);
  expect(report.events.some(event => event.event === "worker-acknowledged")).toBe(false);
});

test("service-worker lifecycle and browser-delivered push diagnostics survive without the site document",
  async ({ page, context }) => {
    await context.grantPermissions(["notifications"]);
    await page.goto("./");
    const session = await context.newCDPSession(page);
    let registrationId;
    session.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      registrationId = registrations.find(item => item.scopeURL.endsWith("/notification-test-site/"))?.registrationId;
    });
    await session.send("ServiceWorker.enable");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("./sw.js", { type: "module" });
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => registrationId).toBeTruthy();
    await page.goto("about:blank");
    await session.send("ServiceWorker.deliverPushMessage", {
      origin: "http://localhost:8769",
      registrationId,
      data: JSON.stringify({
        version: 1, id: "push-diagnostic-browser-test", sentAt: new Date().toISOString(),
        title: "SAA diagnostic browser test", body: "Synthetic CDP delivery, not network push.",
        requireInteraction: false,
      }),
    });
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => worker.evaluate(async () =>
      (await self.registration.getNotifications()).some(notification =>
        notification.data?.id === "push-diagnostic-browser-test"))).toBe(true);
    expect(page.url()).toBe("about:blank");
    await page.goto("./");
    await expect(page.locator("#log")).toContainText("push-show-resolved");
    const report = await downloadReport(page);
    expect(report.events.some(event => event.event === "worker-activate-completed")).toBe(true);
    for (const event of ["push-event", "push-received", "push-display-requested", "push-show-resolved"]) {
      expect(report.events.find(entry => entry.event === event)).toMatchObject({
        source: "worker", version: LAB_VERSION,
      });
    }
    expect(report.worker.active.state).toBe("activated");
    expect(report.worker.scope).toBe("http://localhost:8769/notification-test-site/");
    await session.send("ServiceWorker.deliverPushMessage", {
      origin: "http://localhost:8769", registrationId, data: "{}",
    });
    await expect(page.locator("#log")).toContainText("worker-push-error");
    const failed = await downloadReport(page);
    expect(failed.events.find(event => event.event === "worker-push-error")).toMatchObject({
      source: "worker", level: "error", error: { message: "Missing or invalid push payload." },
    });
    await page.getByRole("button", { name: "Close this site's test notifications", exact: true }).click();
  });
