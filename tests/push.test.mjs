import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import webPush from "web-push";
import { parseDelay, decodePublicKey, validatePushPayload } from "../site/shared.js";
import { handlePush, handleClick } from "../site/push-handler.js";
import { errorDetails } from "../site/diagnostics.js";
import { validateSubscription, createPayload, safeFailure } from "../scripts/send-push.mjs";

const payload = createPayload({}, "test-id", new Date("2026-01-01T00:00:00Z"));
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/synthetic",
  keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
};

test("delay accepts only bounded whole seconds", () => {
  for (const value of ["0", "30", "300"]) assert.equal(parseDelay(value), Number(value));
  for (const value of ["", "-1", "301", "1.5", "1e2", "Infinity", "hello"]) {
    assert.throws(() => parseDelay(value));
  }
});

test("public VAPID decoding rejects missing, malformed, and compressed keys", () => {
  const keys = webPush.generateVAPIDKeys();
  assert.equal(decodePublicKey(keys.publicKey).length, 65);
  for (const key of ["", "invalid", "A".repeat(87)]) assert.throws(() => decodePublicKey(key));
});

test("payload is bounded, typed, and strips unexpected click URLs", () => {
  assert.deepEqual(validatePushPayload({ ...payload, url: "https://unrelated.example" }), payload);
  for (const invalid of [null, {}, { ...payload, version: 2 },
    { ...payload, title: "" }, { ...payload, title: "x".repeat(101) },
    { ...payload, body: "x".repeat(301) }, { ...payload, requireInteraction: "false" },
    { ...payload, id: "../escape" }, { ...payload, sentAt: "invalid" }]) {
    assert.throws(() => validatePushPayload(invalid));
  }
  assert.equal(createPayload({ REQUIRE_INTERACTION: "true" }).requireInteraction, true);
  assert.throws(() => createPayload({ REQUIRE_INTERACTION: "yes" }));
});

test("subscription permits expected push providers, not arbitrary outbound URLs", () => {
  for (const endpoint of [subscription.endpoint, "https://abc.notify.windows.com/w/?token=synthetic",
    "https://updates.push.services.mozilla.com/wpush/v2/synthetic"]) {
    assert.equal(validateSubscription(JSON.stringify({ ...subscription, endpoint })).endpoint, endpoint);
  }
  for (const endpoint of ["http://fcm.googleapis.com/a", "https://127.0.0.1/a",
    "https://fcm.googleapis.com.evil.example/a", "https://fcm.googleapis.com:444/a",
    "https://user:password@fcm.googleapis.com/a", "https://fcm.googleapis.com/a#fragment"]) {
    assert.throws(() => validateSubscription(JSON.stringify({ ...subscription, endpoint })));
  }
  assert.throws(() => validateSubscription("{}"));
  assert.throws(() => validateSubscription(JSON.stringify({ ...subscription, keys: { auth: "x", p256dh: "x" } })));
});

test("real web-push library produces encrypted aes128gcm request with VAPID auth", () => {
  const keys = webPush.generateVAPIDKeys();
  const request = webPush.generateRequestDetails(subscription, JSON.stringify(payload), {
    vapidDetails: { subject: "https://github.com/LuHuangMSFT/notification-test-site",
      publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 300, urgency: "high", contentEncoding: "aes128gcm",
  });
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.match(request.headers.Authorization, /^vapid /);
  assert.ok(Buffer.isBuffer(request.body));
  assert.ok(!request.body.includes(Buffer.from(payload.title)));
});

test("push handler awaits receipt, actual display, and durable completion", async () => {
  const calls = [];
  await handlePush({ data: { json: () => payload } }, {
    scope: "https://luhuangmsft.github.io/notification-test-site/",
    async showNotification(title, options) {
      calls.push("display");
      assert.equal(title, payload.title);
      assert.equal(options.icon, "https://luhuangmsft.github.io/notification-test-site/icon.svg");
      assert.equal(options.tag, `notification-lab:${payload.id}`);
    },
  }, async event => calls.push(event), async () => calls.push("publish"));
  assert.deepEqual(calls, ["push-received", "push-display-requested", "display", "push-show-resolved", "publish"]);
});

test("push display errors are recorded and rejected, not reported as success", async () => {
  const events = [];
  await assert.rejects(handlePush({ data: { json: () => payload } }, {
    scope: "https://example.com/",
    async showNotification() { throw new Error("display rejected"); },
  }, async event => events.push(event), async () => {}), /display rejected/);
  assert.deepEqual(events, ["push-received", "push-display-requested", "push-display-error"]);
});

test("diagnostic storage failure cannot prevent attempting notification display", async () => {
  let displayed = false;
  const messages = [];
  await assert.rejects(handlePush({ data: { json: () => payload } }, {
    scope: "https://example.com/",
    async showNotification() { displayed = true; },
  }, async () => { throw new Error("storage unavailable"); },
  async message => messages.push(message)), /storage unavailable/);
  assert.equal(displayed, true);
  assert.equal(messages[0].type, "lab-error");
});

test("malformed push is a visible diagnostic error, not a successful synthetic notification", async () => {
  const events = [];
  await assert.rejects(handlePush({ data: { json: () => ({}) } }, {
    async showNotification() { assert.fail("Invalid push should not display"); },
  }, async event => events.push(event), async () => {}), /Invalid|invalid/);
  assert.deepEqual(events, ["push-error"]);
});

test("click opens only this project, never a sibling GitHub Pages project", async () => {
  const opened = [];
  await handleClick({ notification: {
    tag: "notification-lab:test", data: { id: "test", url: "https://unrelated.example/" },
    close() {},
  } }, { scope: "https://luhuangmsft.github.io/notification-test-site/" }, {
    async matchAll() { return [{
      url: "https://luhuangmsft.github.io/other-project/", focus() { assert.fail("Wrong app"); },
    }]; },
    async openWindow(url) { opened.push(url); },
  }, async () => {});
  assert.deepEqual(opened, ["https://luhuangmsft.github.io/notification-test-site/"]);
});

test("provider failures never print subscription endpoints or private material", () => {
  for (const error of [
    new Error("https://secret-endpoint.example credential"),
    { statusCode: 410, body: "credential", endpoint: "secret-endpoint" },
    { statusCode: 403, body: "credential" },
  ]) assert.doesNotMatch(safeFailure(error), /secret-endpoint|credential/);
});

test("captured errors preserve useful names and redact credentials and arbitrary rejection objects", () => {
  const key = "a".repeat(87);
  const error = new DOMException(
    `Subscription failed at https://fcm.googleapis.com/secret-endpoint?token=private auth=private-auth ${key}`,
    "NotAllowedError");
  const details = errorDetails(error);
  assert.equal(details.name, "NotAllowedError");
  assert.match(details.message, /Subscription failed/);
  assert.doesNotMatch(JSON.stringify(details), /secret-endpoint|private-auth|private|a{40}/);
  assert.doesNotMatch(JSON.stringify(errorDetails({ endpoint: "secret", keys: subscription.keys })), /secret|p256dh/);
  assert.doesNotMatch(JSON.stringify(errorDetails("Bearer short-credential")), /short-credential/);
});

test("deployed site contains no web app manifest, private key, or subscription export", async () => {
  const files = await readdir(new URL("../site/", import.meta.url));
  assert.ok(!files.some(name => /manifest|subscription/i.test(name)));
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /rel\s*=\s*["']manifest["']/i);
  for (const file of files) {
    const contents = await readFile(new URL(`../site/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(contents, /-----BEGIN.*PRIVATE KEY/);
  }
});
