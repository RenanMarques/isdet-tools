import { defineConfig } from '@playwright/test';
import fs from 'fs';

// Read token from .dev.vars (never committed; only for local integration runs)
function readDevVars() {
  try {
    return Object.fromEntries(
      fs.readFileSync('.dev.vars', 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch { return {}; }
}

const vars = readDevVars();
process.env.TEST_API_TOKEN = process.env.ISDET_TOOLS_API_TOKEN ?? vars.ISDET_TOOLS_API_TOKEN ?? '';

export default defineConfig({
  testDir: './test',
  testMatch: ['**/sdk-integration.spec.js', '**/costs.spec.js'],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8788',
  },
  globalSetup: './test/global-setup-integration.js',
  webServer: {
    command: 'wrangler pages dev . --port 8788',
    url: 'http://127.0.0.1:8788',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
