import { defineConfig } from 'vitest/config';

// GitHub runners have 4 CPUs and 16 GB. Parallel integration files started over 30 MongoDB
// containers at once in a local run, so CI runs one file at a time.
const inCi = Boolean(process.env['CI']);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.claude/**',
            '**/*.integration.test.{ts,tsx}',
          ],
          // Cleans up rendered trees and drains timers before each jsdom file tears down.
          setupFiles: ['packages/ui/src/test-support/vitest-setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.integration.test.{ts,tsx}'],
          fileParallelism: !inCi,
          // Build the shell runtime bundles that the integration tests fork.
          globalSetup: [
            'packages/shell-runtime/src/test/build-global-setup.ts',
            'packages/app/src/test/build-shell-runtime.ts',
          ],
        },
      },
    ],
  },
});
