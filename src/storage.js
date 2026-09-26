/**
 * Local persistence in IndexedDB (blueprint §13).
 *
 * Database `laundry-color-scanner` v1:
 *   settings    keyPath 'name'
 *   corrections keyPath 'id', index 'createdAt'
 *   profiles    keyPath 'id', index 'colorId'
 *
 * Scans are never stored. Only explicit corrections, reference profiles and
 * settings are saved. If IndexedDB is unavailable (private mode, denied,
 * quota), scanning still works and writes report "Could not save locally."
 */
import { validateCorrection, validateGroupingSettings, validateProfile } from './schema.js';

export const DB_NAME = 'laundry-color-scanner';
export const DB_VERSION = 1;
const STORES = ['settings', 'corrections', 'profiles'];

// Storage must never block scanning (blueprint §15): a hung IndexedDB (a
// known Safari failure mode) degrades to "Could not save locally" instead.
export const OPEN_TIMEOUT_MS = 4000;
export const TX_TIMEOUT_MS = 5000;
const IMPORT_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class StorageError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
  }
}

/** Schema upgrades by version; each step is idempotent. */
export function upgradeDatabase(db, oldVersion) {
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'name' });
    if (!db.objectStoreNames.contains('corrections')) {
      db.createObjectStore('corrections', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
    }
    if (!db.objectStoreNames.contains('profiles')) {
      db.createObjectStore('profiles', { keyPath: 'id' }).createIndex('colorId', 'colorId');
    }
  }
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(idb) {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => upgradeDatabase(request.result, event.oldVersion);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

class IdbStorage {
  available = true;

  constructor(db, { txTimeoutMs = TX_TIMEOUT_MS } = {}) {
    this.db = db;
    this.txTimeoutMs = txTimeoutMs;
  }

  async #tx(storeNames, mode, fn, timeoutMs = this.txTimeoutMs) {
    try {
      const tx = this.db.transaction(storeNames, mode);
      const done = new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        tx.onerror = () => reject(tx.error);
      });
      done.catch(() => {}); // observed below; avoid unhandled rejections on early failure
      const work = (async () => {
        const result = await fn(tx);
        await done;
        return result;
      })();
      return await withTimeout(work, timeoutMs, 'IndexedDB transaction timed out');
    } catch (err) {
      throw new StorageError('storage-failed', err);
    }
  }

  async getSetting(name) {
    const row = await this.#tx('settings', 'readonly', (tx) => promisify(tx.objectStore('settings').get(name)));
    return row?.value;
  }

  setSetting(name, value) {
    if (name === 'grouping') validateGroupingSettings(value);
    return this.#tx('settings', 'readwrite', (tx) => promisify(tx.objectStore('settings').put({ name, value })));
  }

  async listCorrections() {
    const rows = await this.#tx('corrections', 'readonly', (tx) => promisify(tx.objectStore('corrections').getAll()));
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  addCorrection(correction) {
    validateCorrection(correction);
    return this.#tx('corrections', 'readwrite', (tx) => promisify(tx.objectStore('corrections').add(correction)));
  }

  deleteCorrection(id) {
    return this.#tx('corrections', 'readwrite', (tx) => promisify(tx.objectStore('corrections').delete(id)));
  }

  listProfiles() {
    return this.#tx('profiles', 'readonly', (tx) => promisify(tx.objectStore('profiles').getAll()));
  }

  putProfile(profile) {
    validateProfile(profile);
    return this.#tx('profiles', 'readwrite', (tx) => promisify(tx.objectStore('profiles').put(profile)));
  }

  deleteProfile(id) {
    return this.#tx('profiles', 'readwrite', (tx) => promisify(tx.objectStore('profiles').delete(id)));
  }

  /** Apply a validated import plan (see data-transfer.js) in one transaction. */
  applyImport(plan) {
    return this.#tx(
      STORES,
      'readwrite',
      (tx) => {
        for (const c of plan.corrections) tx.objectStore('corrections').put(c);
        for (const p of plan.profiles) tx.objectStore('profiles').put(p);
        if (plan.settings?.grouping) tx.objectStore('settings').put({ name: 'grouping', value: plan.settings.grouping });
      },
      IMPORT_TIMEOUT_MS,
    );
  }

  deleteAll() {
    return this.#tx(STORES, 'readwrite', (tx) => {
      for (const store of STORES) tx.objectStore(store).clear();
    });
  }
}

class UnavailableStorage {
  available = false;

  constructor(reason) {
    this.reason = reason;
  }

  async getSetting() {
    return undefined;
  }

  async listCorrections() {
    return [];
  }

  async listProfiles() {
    return [];
  }

  async deleteAll() {}

  async setSetting() {
    throw new StorageError('storage-unavailable', this.reason);
  }

  async addCorrection() {
    throw new StorageError('storage-unavailable', this.reason);
  }

  async deleteCorrection() {
    throw new StorageError('storage-unavailable', this.reason);
  }

  async putProfile() {
    throw new StorageError('storage-unavailable', this.reason);
  }

  async deleteProfile() {
    throw new StorageError('storage-unavailable', this.reason);
  }

  async applyImport() {
    throw new StorageError('storage-unavailable', this.reason);
  }
}

/**
 * Open storage; never throws and never hangs — returns an unavailable
 * implementation instead (after at most `timeoutMs`).
 */
export async function openStorage(idb = globalThis.indexedDB, { timeoutMs = OPEN_TIMEOUT_MS, txTimeoutMs = TX_TIMEOUT_MS } = {}) {
  let opening = null;
  try {
    if (!idb) throw new Error('IndexedDB unavailable');
    opening = openDatabase(idb);
    return new IdbStorage(await withTimeout(opening, timeoutMs, 'IndexedDB open timed out'), { txTimeoutMs });
  } catch (err) {
    // If the open completes after we gave up, close it rather than leak it.
    opening?.then((db) => db.close(), () => {});
    return new UnavailableStorage(err);
  }
}
