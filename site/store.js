import { MAX_EVENTS } from "./shared.js";

const databaseName = "site-as-app-notification-lab";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("events", { keyPath: "sequence", autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Cannot open the local event log."));
    request.onblocked = () => reject(new Error("Local event log is blocked by another page."));
  });
}

async function transaction(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction("events", mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(new Error("Local event log transaction failed."));
      tx.onerror = () => reject(new Error("Local event log storage failed."));
      action(tx.objectStore("events"), value => { result = value; });
    });
  } finally {
    database.close();
  }
}

export function recordEvent(event, details = {}) {
  return transaction("readwrite", store => {
    store.add({ ...details, event, time: new Date().toISOString() });
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
