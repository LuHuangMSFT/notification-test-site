import { test, expect } from "@playwright/test";

test("plain-site load does not install a worker or declare a manifest", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByText("Ready. Choose a notification path above.")).toBeVisible();
  expect(await page.locator('link[rel="manifest"]').count()).toBe(0);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect(page.locator("#environment")).toContainText("browser");
  await expect(page.locator("#environment")).toContainText("true");
  await expect(page.locator("#error")).toBeEmpty();
  expect((await page.request.get("./manifest.json")).status()).toBe(404);
});

test("real document Notification API records a request with granted permission", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.goto("./");
  await page.getByRole("button", { name: "Send tab notification now", exact: true }).click();
  await expect(page.locator("#log")).toContainText("tab-requested");
  await expect(page.locator("#error")).toBeEmpty();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test("tab timer can be canceled and closing the document stops its pending callback", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.clock.install();
  await page.goto("./");
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
  await page.getByRole("button", { name: "Schedule tab notification", exact: true }).click();
  await expect(page.locator("#tab-status")).toContainText("1 pending");
  await page.clock.fastForward(11000);
  await expect(page.locator("#log")).toContainText("tab-requested");
  await expect(page.locator("#tab-status")).toContainText("No pending");
});

test("project-scoped worker activates and event storage remains bounded and durable", async ({ page }) => {
  await page.goto("./");
  const result = await page.evaluate(async () => {
    const worker = await navigator.serviceWorker.register("./sw.js", { type: "module" });
    await navigator.serviceWorker.ready;
    const store = await import("./store.js");
    for (let i = 0; i < 105; i++) await store.recordEvent("bounded-test", { index: i });
    return { scope: worker.scope, events: await store.readEvents() };
  });
  expect(result.scope).toBe("http://localhost:8769/notification-test-site/");
  expect(result.events).toHaveLength(100);
  expect(result.events[0].index).toBe(104);
  await page.reload();
  await expect(page.locator("#log")).toContainText("bounded-test");
  await page.getByRole("button", { name: "Clear local event log", exact: true }).click();
  await expect(page.locator("#log")).toHaveText("[]");
});

test("subscription requires explicit permission; no credentials appear in logs", async ({ page }) => {
  await page.goto("./");
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
  await expect(page.locator("#push-status")).toContainText("Not subscribed.");
  await expect(page.locator("#unsubscribe")).toBeDisabled();
  await expect(page.locator("#error")).toBeEmpty();
});
