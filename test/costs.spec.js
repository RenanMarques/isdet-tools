/**
 * E2E tests for apps/costs/index.html
 *
 * Runs against wrangler pages dev (same setup as sdk-integration.spec.js).
 * Auth is injected via addInitScript so the page's own configure({}) call
 * picks up the test token transparently.
 *
 * Run with: npm run test:integration
 */
import { test, expect } from '@playwright/test';

const TOKEN   = process.env.TEST_API_TOKEN || '';
const API_BASE = 'http://127.0.0.1:8788/api';

/**
 * Navigate to the costs page with the test token pre-injected.
 * Works by intercepting the window.IsdetTools assignment from the SDK IIFE
 * and wrapping configure() so every call automatically receives token + apiBase.
 */
async function openCostsPage(page) {
  await page.addInitScript(({ token, apiBase }) => {
    Object.defineProperty(window, 'IsdetTools', {
      configurable: true,
      set(sdk) {
        const orig = sdk.configure.bind(sdk);
        sdk.configure = (opts = {}) => orig({ ...opts, token, apiBase });
        Object.defineProperty(window, 'IsdetTools', { value: sdk, writable: true, configurable: true });
      },
    });
  }, { token: TOKEN, apiBase: API_BASE });

  await page.goto('/apps/costs/index.html');
  // Wait for the SDK to initialise (configure() is called synchronously during page boot).
  await page.waitForFunction(() => typeof IsdetTools !== 'undefined');
}

/** Wait until the sync queue is empty (same helper pattern as sdk-integration.spec.js). */
async function waitForQueueEmpty(page) {
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('__isdet_sync_queue__') || '[]').length === 0,
    { timeout: 15_000 },
  );
}

// ─── Supply management ────────────────────────────────────────────────────────

test('add a supply: form submission persists the record and shows it in the table', async ({ page }) => {
  await openCostsPage(page);

  const supplyName = `Tinta Sublimática ${Date.now()}`;

  // Switch to the Insumos tab.
  await page.click('button:has-text("Insumos")');

  // Fill the form.
  await page.fill('#ins-name', supplyName);
  await page.selectOption('#ins-technique', 'Sublimação');
  await page.fill('#ins-quantity', '500');
  await page.selectOption('#ins-unit', 'ml');
  await page.fill('#ins-price', '80.00');
  await page.fill('#ins-stock', '500');
  await page.fill('#ins-min-stock', '50');

  // Submit and wait for the record to reach D1.
  await page.click('button:has-text("Cadastrar insumo")');
  await waitForQueueEmpty(page);

  // The table should contain the new supply.
  await expect(page.locator('#table-supplies tbody')).toContainText(supplyName);
  await expect(page.locator('#table-supplies tbody')).toContainText('Sublimação');
});

// ─── Session management ───────────────────────────────────────────────────────

test('add a session: form submission shows the session in the history table', async ({ page }) => {
  await openCostsPage(page);

  // First create a supply so the session form has something to link.
  const supplyName = `Papel Sublimático ${Date.now()}`;

  await page.click('button:has-text("Insumos")');
  await page.fill('#ins-name', supplyName);
  await page.fill('#ins-quantity', '100');
  await page.fill('#ins-price', '40.00');
  await page.fill('#ins-stock', '100');
  await page.click('button:has-text("Cadastrar insumo")');
  await waitForQueueEmpty(page);

  // Switch to Sessões tab.
  await page.click('button:has-text("Sessões")');

  // Fill session form.
  const today = new Date().toISOString().slice(0, 10);
  await page.fill('#ses-date', today);
  await page.selectOption('#ses-technique', 'Sublimação');
  await page.selectOption('#ses-substrate', 'Caneca cerâmica');
  await page.fill('#ses-pieces', '5');
  await page.fill('#ses-approved', '4');
  await page.fill('#ses-score', '8');
  await page.selectOption('#ses-status', 'validated');

  await page.click('button:has-text("Registrar sessão")');
  await waitForQueueEmpty(page);

  // Session should appear in the history table.
  const tbody = page.locator('#table-sessions tbody');
  await expect(tbody).toContainText(today);
  await expect(tbody).toContainText('Sublimação');
  await expect(tbody).toContainText('Caneca cerâmica');
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

test('dashboard: metrics-grid renders after data is loaded', async ({ page }) => {
  await openCostsPage(page);

  // The dashboard panel is active by default.
  // Wait for the SDK boot load() to finish populating metrics.
  await page.waitForFunction(
    () => document.querySelector('#metrics-grid')?.children.length > 0,
    { timeout: 10_000 },
  );

  // Four metric cards must be present.
  const metrics = page.locator('#metrics-grid .metric');
  await expect(metrics).toHaveCount(4);
});

// ─── Unit cost calculator ─────────────────────────────────────────────────────

test('price simulation: calculates suggested price from cost and margin', async ({ page }) => {
  await openCostsPage(page);

  // Navigate to the unit cost tab.
  await page.click('button:has-text("Custo/peça")');

  await page.fill('#sim-custo', '10');
  await page.fill('#sim-margem', '50');
  await page.fill('#sim-outros', '2');

  await page.click('button:has-text("Calcular sugestão de preço")');

  // Total base = 10 + 2 = 12; suggested = 12 / (1 - 0.50) = 24.00
  await expect(page.locator('#sim-resultado')).toContainText('R$ 24,00');
});
