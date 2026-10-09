import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Vitest runs this once before the integration tests. The tests fork the built bundle, so the
// bundle must match the current sources.
export async function setup(): Promise<void> {
  await build({
    root: PACKAGE_ROOT,
    configFile: resolve(PACKAGE_ROOT, 'vite.config.ts'),
    logLevel: 'warn',
  });
}
