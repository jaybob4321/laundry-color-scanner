/**
 * Storage must never block the app: a hung or slow IndexedDB degrades to
 * "unavailable" (open) or a StorageError (operations) within a bounded time.
 * Uses a minimal fake IndexedDB so the failure modes are deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStorage, StorageError } from '../../src/storage.js';

function fakeIndexedDb({ openAfterMs = 0, hangTransactions = false } = {}) {
  const db = {
    closed: false,
    close() {
      this.closed = true;
    },
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {};
      const request = (value) => {
        const req = {};
        if (!hangTransactions) {
          setTimeout(() => {
            req.result = value;
            req.onsuccess?.();
            setTimeout(() => tx.oncomplete?.(), 0);
          }, 0);
        }
        return req;
      };
      const store = { getAll: () => request([]), get: () => request(undefined), put: () => request(undefined) };
      tx.objectStore = () => store;
      return tx;
    },
  };
  const factory = {
    open() {
      const req = {};
      if (openAfterMs !== null) {
        setTimeout(() => {
          req.result = db;
          req.onsuccess?.();
        }, openAfterMs);
      }
      return req;
    },
  };
  return { db, factory };
}

test('a working database opens and answers', async () => {
  const { factory } = fakeIndexedDb();
  const storage = await openStorage(factory, { timeoutMs: 200 });
  assert.equal(storage.available, true);
  assert.deepEqual(await storage.listCorrections(), []);
});

test('an open that never answers degrades to unavailable storage instead of hanging', async () => {
  const { factory } = fakeIndexedDb({ openAfterMs: null });
  const started = Date.now();
  const storage = await openStorage(factory, { timeoutMs: 50 });
  assert.equal(storage.available, false);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await storage.listCorrections(), [], 'reads return empty');
  await assert.rejects(storage.addCorrection({}), (e) => e instanceof StorageError && e.code === 'storage-unavailable');
});

test('a late open is closed rather than leaked', async () => {
  const { db, factory } = fakeIndexedDb({ openAfterMs: 80 });
  const storage = await openStorage(factory, { timeoutMs: 20 });
  assert.equal(storage.available, false);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(db.closed, true);
});

test('a transaction that never completes fails with a StorageError', async () => {
  const { factory } = fakeIndexedDb({ hangTransactions: true });
  const storage = await openStorage(factory, { timeoutMs: 200, txTimeoutMs: 40 });
  assert.equal(storage.available, true);
  const started = Date.now();
  await assert.rejects(storage.listCorrections(), (e) => e instanceof StorageError && e.code === 'storage-failed');
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(storage.getSetting('grouping'), StorageError);
});

test('no IndexedDB at all is reported as unavailable', async () => {
  const storage = await openStorage(undefined);
  assert.equal(storage.available, false);
});
