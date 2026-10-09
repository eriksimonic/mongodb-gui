import { defineConfig } from 'vitest/config';

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
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.integration.test.{ts,tsx}'],
        },
      },
    ],
  },
});
