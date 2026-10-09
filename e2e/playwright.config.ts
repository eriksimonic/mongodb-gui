import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './output/test-results',
  globalSetup: './global-setup.ts',
  // One Electron app at a time, sharing one MongoDB container.
  workers: 1,
  fullyParallel: false,
  // A flaky step is a bug to fix, not a retry to add.
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // The github reporter turns failures into annotations readable without the job log.
  reporter: process.env['GITHUB_ACTIONS'] ? [['list'], ['github']] : [['list']],
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
