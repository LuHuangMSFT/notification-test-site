import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import webPush from "web-push";
import { parseDelay, validatePushPayload } from "../site/shared.js";

export function validateSubscription(value) {
  let subscription;
  try { subscription = JSON.parse(value); } catch { throw new Error("Invalid subscription JSON."); }
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { throw new Error("Invalid push endpoint."); }
  const allowed = endpoint.hostname === "fcm.googleapis.com" ||
    endpoint.hostname.endsWith(".notify.windows.com") ||
    endpoint.hostname === "updates.push.services.mozilla.com" ||
    endpoint.hostname.endsWith(".push.services.mozilla.com");
  if (!allowed || endpoint.protocol !== "https:" || endpoint.port ||
      endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Unsupported push endpoint. Only HTTPS FCM, WNS, and Mozilla push endpoints are allowed.");
  }
  for (const [key, length] of [["p256dh", 65], ["auth", 16]]) {
    const text = subscription.keys?.[key];
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
      throw new Error(`Invalid subscription ${key} key.`);
    }
    const bytes = Buffer.from(text, "base64url");
    if (bytes.length !== length || (key === "p256dh" && bytes[0] !== 4)) {
      throw new Error(`Invalid subscription ${key} key.`);
    }
  }
  return { endpoint: endpoint.href, keys: {
    p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
  } };
}

export function createPayload(env, id = randomUUID(), now = new Date()) {
  const persistent = env.REQUIRE_INTERACTION || "false";
  if (!["true", "false"].includes(persistent)) throw new Error("REQUIRE_INTERACTION must be true or false.");
  return validatePushPayload({
    version: 1, id: `push-${id}`, sentAt: now.toISOString(),
    title: env.NOTIFICATION_TITLE || "SAA push notification",
    body: env.NOTIFICATION_BODY || "Real Web Push received by the service worker.",
    requireInteraction: persistent === "true",
  });
}

export async function sendPush(env = process.env) {
  const subscription = validateSubscription(env.WEB_PUSH_SUBSCRIPTION);
  const delay = parseDelay(env.DELAY_SECONDS ?? "0");
  const config = JSON.parse(await readFile(new URL("../site/config.json", import.meta.url), "utf8"));
  if (!env.VAPID_PRIVATE_KEY) throw new Error("VAPID_PRIVATE_KEY is not configured.");
  webPush.setVapidDetails(`https://github.com/${config.repository}`,
    config.vapidPublicKey, env.VAPID_PRIVATE_KEY);
  // Validate inputs before waiting; timestamp the actual send, not the queued job.
  createPayload(env);
  console.log(`Waiting ${delay} seconds before sending one Web Push message.`);
  await sleep(delay * 1000);
  const payload = createPayload(env);
  const result = await webPush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 300, urgency: "high", contentEncoding: "aes128gcm", timeout: 15000,
  });
  console.log(JSON.stringify({
    id: payload.id, sentAt: payload.sentAt, pushServiceStatus: result.statusCode,
    result: "Push service accepted the message. Check the worker log and OS UI for delivery.",
  }));
}

export function safeFailure(error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  if (status === 404 || status === 410) {
    return `Push service returned ${status}. Subscribe again and replace WEB_PUSH_SUBSCRIPTION.`;
  }
  if (status) return `Push service returned HTTP ${status}. Check the saved subscription and VAPID key pair.`;
  // Provider errors can contain subscription endpoints and key material.
  return "Push failed. Check the subscription secret, VAPID configuration, input limits, and network access.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sendPush().catch(error => {
    console.error(safeFailure(error));
    process.exitCode = 1;
  });
}
