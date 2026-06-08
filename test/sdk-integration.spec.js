'   '     /**
 * Integration tests for isdet-tools-sdk.js
 *
 * These tests run against a real wrangler pages dev instance with a local D1
 * database. No fetch mocking — every API call hits the actual Worker.
 *
 * Run with: npm run test:integration
 * Requires: wrangler in PATH, .dev.vars with ISDET_TOOLS_API_TOKEN
 */
import { test, expect } from '@playwright/test';

const TOKEN   = process.env.TEST_API_TOKEN || '';
const API_BASE = 'http://127.0.0.1:8788/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Unique namespace per test — isolates D1 rows without any cleanup logic. */
function ns() {
  return `it${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Initialize the SDK on the page with the local API base and token. */
async function initSDK(page) {
  await page.goto('/test/fixture.html');
  await page.evaluate(([token, apiBase]) => {
    IsdetTools.configure({ token, apiBase });
  }, [TOKEN, API_BASE]);
}

/**
 * Wait until the sync queue is empty.
 * The SDK drains the queue asynchronously; this polls localStorage until done.
 */
async function waitForQueueEmpty(page) {
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('__isdet_sync_queue__') || '[]').length === 0,
    { timeout: 15_000 },
  );
}

/** Direct API call via the page's fetch (same origin, no CORS). */
async function apiRequest(page, method, path, body = null, extraHeaders = {}) {
  return page.evaluate(
    async ({ token, apiBase, method, path, body, extraHeaders }) => {
      const r = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    },
    { token: TOKEN, apiBase: API_BASE, method, path, body, extraHeaders },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('saved record reaches D1 and is retrievable after localStorage is cleared', async ({ page }) => {
  const namespace = ns();
  await initSDK(page);

  await page.evaluate(async ([namespace]) => {
    const col = IsdetTools.createStore(namespace).collection('items');
    await col.save({ id: 'x', name: 'hello', value: 42 });
  }, [namespace]);

  await waitForQueueEmpty(page);

  // Reload with clean localStorage to force the SDK to fetch from D1.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await initSDK(page);

  // findAll() returns [] immediately (cache empty), then fires background read.
  const immediate = await page.evaluate(([namespace]) =>
    IsdetTools.createStore(namespace).collection('items').findAll()
  , [namespace]);
  expect(immediate).toHaveLength(0);

  // Wait for background read to populate the local cache from D1.
  await page.waitForFunction(([namespace]) => {
    const idx = JSON.parse(localStorage.getItem(`__isdet__${namespace}__items__$index`) || '[]');
    return idx.length > 0;
  }, [namespace], { timeout: 10_000 });

  const cached = await page.evaluate(([namespace]) => {
    const raw = localStorage.getItem(`__isdet__${namespace}__items__x`);
    return JSON.parse(raw).data;
  }, [namespace]);

  expect(cached.name).toBe('hello');
  expect(cached.value).toBe(42);
});

test('OCC: stale expectedVersion causes 409 which is persisted to dead-letter', async ({ page }) => {
  const namespace = ns();
  await initSDK(page);

  // 1. Create the record and flush — D1 now has x at version uuid-1.
  await page.evaluate(async ([namespace]) => {
    await IsdetTools.createStore(namespace).collection('items').save({ id: 'x', name: 'original' });
  }, [namespace]);
  await waitForQueueEmpty(page);

  // 2. Bypass the SDK and update x on the server with a new version.
  const patch = await apiRequest(
    page, 'PUT', `/${namespace}/items/x`,
    { id: 'x', name: 'server-update' },
    { 'X-New-Version': 'v-external' },
  );
  expect(patch.status).toBe(200);

  // 3. The local cache still holds the old _version. Save again — the SDK will
  //    queue a PUT with If-Match: <old-version>, which the server will reject.
  await page.evaluate(async ([namespace]) => {
    await IsdetTools.createStore(namespace).collection('items').save({ id: 'x', name: 'local-update' });
  }, [namespace]);
  await waitForQueueEmpty(page);

  // 4. The 409 should have landed in the dead-letter queue.
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('__isdet_dead_letter__') || '[]').length > 0,
    { timeout: 10_000 },
  );

  const dead = await page.evaluate(() => IsdetTools.getDeadLetterOps());
  expect(dead).toHaveLength(1);
  expect(dead[0].type).toBe('conflict');
  expect(dead[0].op.collection).toBe('items');
});

test('remove syncs to server: record returns 404 after flush', async ({ page }) => {
  const namespace = ns();
  await initSDK(page);

  // Save and sync.
  await page.evaluate(async ([namespace]) => {
    await IsdetTools.createStore(namespace).collection('items').save({ id: 'y', name: 'bye' });
  }, [namespace]);
  await waitForQueueEmpty(page);

  // Verify the record exists on the server.
  const before = await apiRequest(page, 'GET', `/${namespace}/items/y`);
  expect(before.status).toBe(200);
  expect(before.body.data.name).toBe('bye');

  // Remove locally and flush.
  await page.evaluate(async ([namespace]) => {
    await IsdetTools.createStore(namespace).collection('items').remove('y');
  }, [namespace]);
  await waitForQueueEmpty(page);

  // The server should now return 404.
  const after = await apiRequest(page, 'GET', `/${namespace}/items/y`);
  expect(after.status).toBe(404);
});

test('background read refreshes stale local cache when server version differs', async ({ page }) => {
  const namespace = ns();
  await initSDK(page);

  // Save and sync — server and local both at version uuid-1.
  await page.evaluate(async ([namespace]) => {
    await IsdetTools.createStore(namespace).collection('items').save({ id: 'z', name: 'stale' });
  }, [namespace]);
  await waitForQueueEmpty(page);

  // Update on the server directly (no local write).
  await apiRequest(
    page, 'PUT', `/${namespace}/items/z`,
    { id: 'z', name: 'fresh' },
    { 'X-New-Version': 'v-server-2' },
  );

  // Calling find() returns the stale local value immediately but fires a
  // background GET. Because server version ≠ local version, the cache updates.
  const staleValue = await page.evaluate(([namespace]) =>
    IsdetTools.createStore(namespace).collection('items').find('z')
  , [namespace]);
  expect(staleValue.name).toBe('stale');

  // Wait until the background read has written the new version to localStorage.
  await page.waitForFunction(([namespace]) => {
    const raw = localStorage.getItem(`__isdet__${namespace}__items__z`);
    return raw ? JSON.parse(raw)._version === 'v-server-2' : false;
  }, [namespace], { timeout: 10_000 });

  const freshValue = await page.evaluate(([namespace]) =>
    IsdetTools.createStore(namespace).collection('items').find('z')
  , [namespace]);
  expect(freshValue.name).toBe('fresh');
});

test('multiple records in a collection all sync and are retrieved after cache clear', async ({ page }) => {
  const namespace = ns();
  await initSDK(page);

  const items = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ];

  await page.evaluate(async ([namespace, items]) => {
    const col = IsdetTools.createStore(namespace).collection('items');
    for (const item of items) await col.save(item);
  }, [namespace, items]);

  await waitForQueueEmpty(page);

  // Clear cache and reload.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await initSDK(page);

  // Trigger findAll() so the background read fires.
  await page.evaluate(([namespace]) =>
    IsdetTools.createStore(namespace).collection('items').findAll()
  , [namespace]);

  // Wait for all 3 records to arrive from D1.
  await page.waitForFunction(([namespace]) => {
    const idx = JSON.parse(localStorage.getItem(`__isdet__${namespace}__items__$index`) || '[]');
    return idx.length === 3;
  }, [namespace], { timeout: 10_000 });

  const ids = await page.evaluate(([namespace]) =>
    JSON.parse(localStorage.getItem(`__isdet__${namespace}__items__$index`))
  , [namespace]);

  expect(ids.sort()).toEqual(['a', 'b', 'c']);
});
