import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/sdk.spec.js',
  use: {
    baseURL: 'http://127.0.0.1:3333',
  },
  webServer: {
    command: 'node test/server.js',
    url: 'http://127.0.0.1:3333',
    reuseExistingServer: !process.env.CI,
  },
});
