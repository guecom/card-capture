import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  timeout: 30_000,
  use: {
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
});
