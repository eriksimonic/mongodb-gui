import { defineConfig } from 'vitest/config';

// Running vitest from this folder would otherwise use the browser config in vite.config.ts and skip
// the setup file, so rendered trees pile up between tests. The root vitest.config.ts is the main one.
export default defineConfig({
  test: {
    setupFiles: ['src/test-support/vitest-setup.ts'],
  },
});
