export const MAX_EVENTS = 500;
export const LAB_VERSION = "diagnostics-1";
export const TAG_PREFIX = "notification-lab:";

export function parseDelay(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || Number(text) > 300) {
    throw new Error("Delay must be a whole number from 0 to 300 seconds.");
  }
  return Number(text);
}

export function decodePublicKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value)) {
    throw new Error("Push is not configured: the public VAPID key is missing or invalid.");
  }
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    character => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new Error("The public VAPID key must be an uncompressed P-256 point.");
  }
  return bytes;
}

export function validatePushPayload(payload) {
  if (!payload || payload.version !== 1 ||
      typeof payload.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(payload.id) ||
      typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 100 ||
      typeof payload.body !== "string" || payload.body.length > 300 ||
      typeof payload.requireInteraction !== "boolean" ||
      typeof payload.sentAt !== "string" || !Number.isFinite(Date.parse(payload.sentAt))) {
    throw new Error("Invalid push payload.");
  }
  return {
    version: 1, id: payload.id, title: payload.title, body: payload.body,
    requireInteraction: payload.requireInteraction, sentAt: payload.sentAt,
  };
}

export function notificationOptions(payload, baseURL) {
  return {
    body: payload.body,
    tag: `${TAG_PREFIX}${payload.id}`,
    requireInteraction: payload.requireInteraction,
    icon: new URL("icon.svg", baseURL).href,
    data: { id: payload.id, sentAt: payload.sentAt },
  };
}
