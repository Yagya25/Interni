import type { Analysis, Photograph } from "./types";

/**
 * Keeping a photograph between visits.
 *
 * The image is a Blob and belongs in IndexedDB, where it is stored as
 * binary: encoding a few megabytes of JPEG into base64 to push through
 * localStorage would inflate it by a third, block the main thread and run
 * into a quota measured in single-digit megabytes.
 *
 * It never leaves the browser. There is nowhere to send it to.
 */

const DB_NAME = "datum-source";
const DB_VERSION = 1;
const STORE = "photograph";
/** One held photograph at a time, under a known key. */
const KEY = "current";

export interface StoredSource {
  photograph: Photograph;
  analysis: Analysis | null;
  blob: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = work(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
        // The connection is not needed once the transaction settles.
        request.transaction?.addEventListener("complete", () => db.close());
      }),
  );
}

/** Private browsing and blocked storage both simply mean "not kept". */
export async function save(source: StoredSource): Promise<boolean> {
  try {
    await run("readwrite", (store) => store.put(source, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function load(): Promise<StoredSource | null> {
  try {
    const stored = await run<StoredSource | undefined>("readonly", (store) => store.get(KEY));
    return stored && stored.blob instanceof Blob ? stored : null;
  } catch {
    return null;
  }
}

export async function clear(): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(KEY));
  } catch {
    // Nothing to do: the photograph is gone from this session either way.
  }
}
