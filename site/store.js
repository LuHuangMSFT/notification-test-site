import { MAX_EVENTS } from "./shared.js";

const databaseName = "site-as-app-notification-lab";
const storageTimeoutMs = 3000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let finished = false;
    const timer = setTimeout(() => fail("Local event log open timed out."), storageTimeoutMs);
    function fail(error) {
      finished = true;
      clearTimeout(timer);
      reject(typeof error === "string" ? new Error(error) : error);
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore("events", { keyPath: "sequence", autoIncrement: true });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (finished) request.result.close();
      else { finished = true; resolve(request.result); }
    };
    request.onerror = () => fail(request.error || "Cannot open the local event log.");
    request.onblocked = () => fail("Local event log is blocked by another page.");
  });
}

async function transaction(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction("events", mode);
      let result;
      const timer = setTimeout(() => reject(new Error("Local event log transaction timed out.")), storageTimeoutMs);
      tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
      tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error("Local event log transaction failed.")); };
      tx.onerror = event => {
        clearTimeout(timer);
        reject(event.target.error || tx.error || new Error("Local event log storage failed."));
      };
      action(tx.objectStore("events"), value => { result = value; });
    });
  } finally {
    database.close();
  }
}

export function recordEvent(event, details = {}) {
  return transaction("readwrite", store => {
    store.add({ time: new Date().toISOString(), ...details, event });
    const request = store.getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result.slice(0, -MAX_EVENTS)) store.delete(key);
    };
  });
}

export function readEvents() {
  return transaction("readonly", (store, result) => {
    const request = store.getAll();
    request.onsuccess = () => result(request.result.reverse());
  });
}

export function clearEvents() {
  return transaction("readwrite", store => store.clear());
}
