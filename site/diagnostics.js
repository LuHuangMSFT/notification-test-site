import { MAX_EVENTS, LAB_VERSION } from "./shared.js";
import { recordEvent, readEvents, clearEvents } from "./store.js";

export const contextId = crypto.randomUUID();
const source = typeof document === "undefined" ? "worker" : "page";
const recent = [];
let storageError = null;
let persisted = [];

function redact(text) {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-authorization]")
    .replace(/\b(endpoint|auth|p256dh|token|password|secret|vapid[_-]?private[_-]?key)\b\s*[:=]\s*["']?[^,\s"'}]+/gi,
      "$1=[redacted]")
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted-key]")
    .slice(0, 4000);
}

export function errorDetails(error) {
  return {
    name: typeof error?.name === "string" ? redact(error.name) : "Error",
    message: typeof error?.message === "string" ? redact(error.message)
      : typeof error === "string" ? redact(error) : `Non-Error failure (${typeof error}).`,
    ...(typeof error?.stack === "string" ? { stack: redact(error.stack) } : {}),
  };
}

export function diagnosticURL(value) {
  let url;
  try { url = new URL(value); } catch { return "[invalid-url]"; }
  const project = new URL("./", import.meta.url);
  if (url.origin !== project.origin || !url.pathname.startsWith(project.pathname)) {
    return "[external-url]";
  }
  return `${url.origin}${url.pathname}`;
}

function remember(entry) {
  recent.push(entry);
  if (recent.length > MAX_EVENTS) recent.shift();
}

function emit(entry, saved = false) {
  const method = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info";
  console[method](`[Notification Lab]${saved ? "[saved]" : ""}[${entry.source}] ${JSON.stringify(entry)}`);
}

function storageFailure(error) {
  const details = errorDetails(error);
  if (storageError?.message === details.message) return;
  storageError = details;
  const entry = {
    event: "diagnostic-storage-error", error: details, level: "error", source,
    contextId, version: LAB_VERSION, eventId: crypto.randomUUID(), time: new Date().toISOString(),
  };
  remember(entry);
  emit(entry);
}

// Only known diagnostic fields belong here, never a subscription or raw payload.
export async function recordDiagnostic(event, details = {}, level = "info") {
  const entry = {
    ...details, event, level, source, contextId, version: LAB_VERSION,
    eventId: crypto.randomUUID(), time: new Date().toISOString(),
  };
  remember(entry);
  emit(entry);
  if (storageError) return;
  try {
    await recordEvent(event, entry);
  } catch (error) {
    storageFailure(error);
  }
}

export async function readDiagnostics() {
  if (!storageError) {
    try {
      persisted = await readEvents();
    } catch (error) {
      storageFailure(error);
    }
  }
  const combined = new Map(recent.map(entry => [entry.eventId, entry]));
  for (const entry of persisted) {
    const saved = { ...entry };
    if (!saved.eventId) {
      if (typeof saved.url === "string") saved.url = diagnosticURL(saved.url);
      for (const field of ["message", "error"]) {
        if (typeof saved[field] === "string") saved[field] = redact(saved[field]);
      }
      saved.source = "legacy";
    }
    combined.set(saved.eventId || `legacy-${saved.sequence}`, saved);
  }
  return {
    events: [...combined.values()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, MAX_EVENTS),
    storage: {
      limit: MAX_EVENTS,
      error: storageError,
      note: storageError ? "Storage failed. New events are memory-only and may be lost on close. Export now; reload or clear the log to retry storage."
        : "Latest events are stored locally. Clearing browser data removes them.",
    },
  };
}

export async function clearDiagnostics() {
  await clearEvents();
  recent.length = 0;
  persisted = [];
  storageError = null;
}

export function printDiagnostics(report) {
  const { events, ...snapshot } = report;
  console.info(`[Notification Lab] Diagnostic snapshot ${JSON.stringify(snapshot)}`);
  for (const event of [...events].reverse()) emit(event, true);
}

export function installErrorHandlers(report) {
  globalThis.addEventListener("error", event => {
    const resource = event.target?.src || event.target?.href;
    const details = {
      filename: event.filename ? diagnosticURL(event.filename) : resource ? diagnosticURL(resource) : null,
      line: event.lineno || null, column: event.colno || null,
    };
    event.preventDefault();
    void report(event.error || new Error(event.message || "A page resource failed to load."),
      resource ? "resource-error" : "runtime-error", details);
  }, true);
  globalThis.addEventListener("unhandledrejection", event => {
    event.preventDefault();
    void report(event.reason, "unhandled-rejection");
  });
}
