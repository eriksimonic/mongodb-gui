import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Vitest runs this once before the integration tests. The supervisor test forks the bundle that
// the app ships, so it must match the current sources of the runtime.
export async function setup(): Promise<void> {
  await build({
    root: APP_ROOT,
    configFile: resolve(APP_ROOT, 'vite.shell-runtime.config.ts'),
    logLevel: 'warn',
  });
}
