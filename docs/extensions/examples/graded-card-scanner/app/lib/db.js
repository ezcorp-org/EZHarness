// @ts-check
// IndexedDB saved-list store. Thin promise wrapper — all list/detail
// logic lives in format.js; this module only persists.
//
// Row shape: { cert, status: "pending"|"done"|"error", error?, record,
//              scans: string[] (ISO, newest last), savedAt, updatedAt }

/** @typedef {import("./format.js").CardRecord} CardRecord */
/**
 * @typedef {{
 *   cert: string,
 *   status: "pending"|"done"|"error",
 *   error?: string,
 *   record: CardRecord|null,
 *   scans: string[],
 *   savedAt: string,
 *   updatedAt: string,
 * }} SavedCard
 */

const DB_NAME = "graded-card-scanner";
const STORE = "cards";

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "cert" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/**
 * @param {"readonly"|"readwrite"} mode
 * @returns {Promise<{store: IDBObjectStore, db: IDBDatabase}>}
 */
async function tx(mode) {
  const db = await openDb();
  return { store: db.transaction(STORE, mode).objectStore(STORE), db };
}

/** @param {SavedCard} card @returns {Promise<void>} */
export async function putCard(card) {
  const { store, db } = await tx("readwrite");
  await done(store.put(card));
  db.close();
}

/** @param {string} cert @returns {Promise<SavedCard|undefined>} */
export async function getCard(cert) {
  const { store, db } = await tx("readonly");
  const row = await done(store.get(cert));
  db.close();
  return row;
}

/** Newest scan first. @returns {Promise<SavedCard[]>} */
export async function listCards() {
  const { store, db } = await tx("readonly");
  const rows = /** @type {SavedCard[]} */ (await done(store.getAll()));
  db.close();
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** @param {string} cert @returns {Promise<void>} */
export async function deleteCard(cert) {
  const { store, db } = await tx("readwrite");
  await done(store.delete(cert));
  db.close();
}

/** @returns {Promise<void>} */
export async function clearCards() {
  const { store, db } = await tx("readwrite");
  await done(store.clear());
  db.close();
}
