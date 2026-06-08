import { test, expect } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Reads a key directly from the page's localStorage. */
function lsGet(page, key) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);
}

/** Sets a key directly in the page's localStorage. */
function lsSet(page, key, value) {
  return page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [key, value]);
}

/** Waits until a localStorage key satisfies a predicate (polled by Playwright). */
function waitForLs(page, key, predicate, options) {
  return page.waitForFunction(
    ([k, src]) => {
      const val = JSON.parse(localStorage.getItem(k) || 'null');
      return (new Function('val', `return (${src})(val)`))(val);
    },
    [key, predicate.toString()],
    options,
  );
}

// Mock for all background GET requests (collection list + single record).
const EMPTY_LIST = { status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) };
const NOT_FOUND  = { status: 404, contentType: 'application/json', body: '{}' };
const PUT_OK     = { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) };

// ─── Dead-letter queue ───────────────────────────────────────────────────────

test.describe('dead-letter queue', () => {

  test('409 without onConflict is persisted and survives a page reload', async ({ page }) => {
    await page.route('**/api/**', async (route) => {
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ version: 'sv1', data: {} }) })
        : route.fulfill(EMPTY_LIST);
    });

    await page.goto('/test/fixture.html');
    await page.evaluate(async () => {
      IsdetTools.configure({});
      await IsdetTools.createStore('t').collection('items').save({ id: 'x', name: 'local' });
    });

    await waitForLs(page, '__isdet_dead_letter__', (v) => Array.isArray(v) && v.length > 0);

    await page.reload();
    await page.evaluate(() => IsdetTools.configure({}));

    const dead = await page.evaluate(() => IsdetTools.getDeadLetterOps());
    expect(dead).toHaveLength(1);
    expect(dead[0].type).toBe('conflict');
  });

  test('op that exhausts max retries is moved to dead-letter', async ({ page }) => {
    await page.route('**/api/**', (route) =>
      route.request().method() === 'PUT' ? route.fulfill({ status: 503 }) : route.fulfill(EMPTY_LIST)
    );

    await page.goto('/test/fixture.html');

    // Pre-seed queue with an op already at retries: 4 — one more failure reaches the limit (maxRetries: 5).
    await lsSet(page, '__isdet_sync_queue__', [{
      type: 'save', namespace: 't', collection: 'items', id: 'x',
      data: { id: 'x' }, expectedVersion: null, newVersion: 'v1',
      dependsOn: null, retries: 4, timestamp: Date.now(),
    }]);

    await page.evaluate(async () => {
      IsdetTools.configure({});
      await IsdetTools.sync();
    });

    await waitForLs(page, '__isdet_dead_letter__', (v) => Array.isArray(v) && v.length > 0);

    const dead = await page.evaluate(() => IsdetTools.getDeadLetterOps());
    expect(dead[0].type).toBe('max_retries');
  });

  test('causal conflict without onCausalConflict handler is persisted to dead-letter', async ({ page }) => {
    await page.route('**/api/**', (route) => route.fulfill(EMPTY_LIST));

    await page.goto('/test/fixture.html');

    // Supply s1 is at version v2 locally; queue has a session that declared dependency on v1.
    await lsSet(page, '__isdet__t__supplies__s1', {
      data: { id: 's1' }, _createdAt: 0, _updatedAt: 0, _version: 'v2', _dependsOn: null,
    });
    await lsSet(page, '__isdet_sync_queue__', [{
      type: 'save', namespace: 't', collection: 'sessions', id: 'ses1',
      data: { id: 'ses1' }, expectedVersion: null, newVersion: 'sv1',
      dependsOn: [{ collection: 'supplies', id: 's1', version: 'v1' }],
      retries: 0, timestamp: Date.now(),
    }]);

    await page.evaluate(async () => {
      IsdetTools.configure({});
      await IsdetTools.sync();
    });

    await waitForLs(page, '__isdet_dead_letter__', (v) => Array.isArray(v) && v.length > 0);

    const dead = await page.evaluate(() => IsdetTools.getDeadLetterOps());
    expect(dead[0].type).toBe('causal_conflict');
  });

  test('dismissDeadLetterOp removes the entry from localStorage', async ({ page }) => {
    await page.route('**/api/**', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ version: 'sv1', data: {} }) })
        : route.fulfill(EMPTY_LIST)
    );

    await page.goto('/test/fixture.html');
    await page.evaluate(async () => {
      IsdetTools.configure({});
      await IsdetTools.createStore('t').collection('items').save({ id: 'x' });
    });

    await waitForLs(page, '__isdet_dead_letter__', (v) => Array.isArray(v) && v.length > 0);

    await page.evaluate(async () => {
      const [entry] = await IsdetTools.getDeadLetterOps();
      await IsdetTools.dismissDeadLetterOp(entry.id);
    });

    const dead = await page.evaluate(() => IsdetTools.getDeadLetterOps());
    expect(dead).toHaveLength(0);
  });

});

// ─── Version-based staleness detection ───────────────────────────────────────

test.describe('version-based staleness detection', () => {

  test('background read does not update cache when server version matches local', async ({ page }) => {
    await page.route('**/api/t/items/x', (route) =>
      route.fulfill({
        ...PUT_OK,
        body: JSON.stringify({
          id: 'x', version: 'v1',
          data: { id: 'x', name: 'from-server' },
          created_at: 0, updated_at: Date.now() + 99_999,
        }),
      })
    );

    await page.goto('/test/fixture.html');
    await lsSet(page, '__isdet__t__items__x', {
      data: { id: 'x', name: 'local' },
      _createdAt: 0, _updatedAt: 0, _version: 'v1', _dependsOn: null,
    });

    // find() triggers the background GET — wait for it to complete.
    const bgRead = page.waitForResponse('**/api/t/items/x');
    await page.evaluate(() => {
      IsdetTools.configure({});
      IsdetTools.createStore('t').collection('items').find('x');
    });
    await bgRead;
    // Allow microtasks inside the .then() handler to settle.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));

    const stored = await lsGet(page, '__isdet__t__items__x');
    expect(stored.data.name).toBe('local'); // not overwritten
  });

  test('background read updates cache when server version differs', async ({ page }) => {
    await page.route('**/api/t/items/x', (route) =>
      route.fulfill({
        ...PUT_OK,
        body: JSON.stringify({
          id: 'x', version: 'v2',
          data: { id: 'x', name: 'from-server' },
          created_at: 0, updated_at: 0,
        }),
      })
    );

    await page.goto('/test/fixture.html');
    await lsSet(page, '__isdet__t__items__x', {
      data: { id: 'x', name: 'local' },
      _createdAt: 0, _updatedAt: 0, _version: 'v1', _dependsOn: null,
    });

    await page.evaluate(() => {
      IsdetTools.configure({});
      IsdetTools.createStore('t').collection('items').find('x');
    });

    await waitForLs(page, '__isdet__t__items__x', (v) => v?._version === 'v2');

    const stored = await lsGet(page, '__isdet__t__items__x');
    expect(stored.data.name).toBe('from-server');
  });

});

// ─── Index atomicity ─────────────────────────────────────────────────────────

test.describe('index atomicity', () => {

  test('record write failure after index write leaves no invisible record in findAll', async ({ page }) => {
    await page.goto('/test/fixture.html');

    // Intercept the second isdet setItem call (the record write) and throw.
    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      let isdetWrites = 0;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('__isdet__t__items__') && !key.endsWith('$index')) {
          isdetWrites++;
          if (isdetWrites === 1) {
            Storage.prototype.setItem = orig; // restore immediately
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
          }
        }
        return orig.call(this, key, value);
      };
    });

    const threw = await page.evaluate(async () => {
      IsdetTools.configure({});
      try {
        await IsdetTools.createStore('t').collection('items').save({ id: 'x', name: 'foo' });
        return false;
      } catch { return true; }
    });
    expect(threw).toBe(true);

    // Index has the orphaned entry (index was written before the record threw).
    const idx = await lsGet(page, '__isdet__t__items__$index');
    expect(idx).toContain('x');

    // But the record itself was never written.
    const record = await lsGet(page, '__isdet__t__items__x');
    expect(record).toBeNull();

    // findAll() filters the null → app sees an empty list, not a crash.
    const all = await page.evaluate(() =>
      IsdetTools.createStore('t').collection('items').findAll()
    );
    expect(all).toHaveLength(0);
  });

});

// ─── Storage quota ───────────────────────────────────────────────────────────

test.describe('storage quota', () => {

  test('save() rejects with QuotaExceededError when localStorage is full', async ({ page }) => {
    await page.goto('/test/fixture.html');

    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key) {
        if (key.startsWith('__isdet__')) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        return orig.call(this, ...arguments);
      };
    });

    const errorName = await page.evaluate(async () => {
      IsdetTools.configure({});
      try {
        await IsdetTools.createStore('t').collection('items').save({ id: 'x' });
        return null;
      } catch (e) { return e.name; }
    });

    expect(errorName).toBe('QuotaExceededError');
  });

});

// ─── Multi-tab sync via BroadcastChannel ─────────────────────────────────────

test.describe('multi-tab sync', () => {

  test('write in tab A propagates to tab B localStorage via BroadcastChannel', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    for (const p of [pageA, pageB]) {
      await p.route('**/api/**', (route) =>
        route.request().method() === 'GET' ? route.fulfill(EMPTY_LIST) : route.fulfill(PUT_OK)
      );
    }

    await pageA.goto('/test/fixture.html');
    await pageB.goto('/test/fixture.html');

    await pageA.evaluate(() => IsdetTools.configure({}));
    await pageB.evaluate(() => IsdetTools.configure({}));

    await pageA.evaluate(async () => {
      await IsdetTools.createStore('t').collection('items').save({ id: 'shared', value: 42 });
    });

    // Tab B's localStorage should receive the write via BroadcastChannel.
    await waitForLs(pageB, '__isdet__t__items__shared', (v) => v !== null, { timeout: 3000 });

    const stored = await lsGet(pageB, '__isdet__t__items__shared');
    expect(stored.data.value).toBe(42);
  });

  test('onCrossTabWrite fires in tab B when tab A writes', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    for (const p of [pageA, pageB]) {
      await p.route('**/api/**', (route) =>
        route.request().method() === 'GET' ? route.fulfill(EMPTY_LIST) : route.fulfill(PUT_OK)
      );
    }

    await pageA.goto('/test/fixture.html');
    await pageB.goto('/test/fixture.html');

    await pageA.evaluate(() => IsdetTools.configure({}));
    await pageB.evaluate(() => {
      IsdetTools.configure({});
      window.__crossTabFired = false;
      IsdetTools.onCrossTabWrite(() => { window.__crossTabFired = true; });
    });

    await pageA.evaluate(async () => {
      await IsdetTools.createStore('t').collection('items').save({ id: 'ping', value: 1 });
    });

    await pageB.waitForFunction(() => window.__crossTabFired === true, { timeout: 3000 });

    const fired = await pageB.evaluate(() => window.__crossTabFired);
    expect(fired).toBe(true);
  });

});
