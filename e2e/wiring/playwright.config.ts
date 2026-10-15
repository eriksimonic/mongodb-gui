import { defineConfig } from '@playwright/test';

// E2E_SEGMENT picks the stack and the spec folder. global-setup.ts reads the same value.
const segment = process.env['E2E_SEGMENT'] ?? 'standalone';

export default defineConfig({
  testDir: `./journeys/${segment}`,
  outputDir: '../output/wiring-results',
  globalSetup: './global-setup.ts',
  // Every test starts its own router, so one worker keeps the Vite loader and the Mongo stack simple.
  workers: 1,
  fullyParallel: false,
  // A flaky step is a bug to fix, not a retry to add.
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // The github reporter turns failures into annotations readable without the job log.
  reporter: process.env['GITHUB_ACTIONS'] ? [['list'], ['github']] : [['list']],
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
