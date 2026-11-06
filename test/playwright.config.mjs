import { defineConfig } from '@playwright/test';

// Each test launches its own Chrome with the extension (see e2e.spec.mjs).
export default defineConfig({
  testDir: '.',
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
