import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { optionalModuleAliases, optionalModuleCommonjsOptions } from '../../../scripts/main-build';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILD_TIMEOUT_MS = 60_000;

// The fixture reads the optional modules the way the driver does: a require, then the
// kModuleError check, then a use that must throw the install message.
const FIXTURE = `
const snappy = require('snappy');
const kerberos = require('kerberos');

function useOrMessage(module) {
  try {
    return module.compress('x');
  } catch (error) {
    return error.message;
  }
}

globalThis.stubProbe = {
  snappyMissing: 'kModuleError' in snappy,
  kerberosMissing: 'kModuleError' in kerberos,
  snappyUse: useOrMessage(snappy),
  kerberosUse: useOrMessage(kerberos),
};
`;

// Bundles the fixture with the main build's settings and loads the result as CommonJS.
async function bundleAndLoad(source: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'optional-stub-build-'));
  try {
    const input = join(dir, 'fixture.js');
    writeFileSync(input, source);
    const outDir = join(dir, 'out');
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      resolve: { alias: optionalModuleAliases(APP_ROOT) },
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        target: 'node24',
        commonjsOptions: { ...optionalModuleCommonjsOptions(), include: [/fixture\.js$/] },
        rollupOptions: {
          input,
          output: { format: 'cjs', entryFileNames: 'fixture.cjs' },
        },
      },
    });
    const bundled = join(outDir, 'fixture.cjs');
    const requireBundle = createRequire(bundled);
    // Reading the file first keeps a missing output from looking like a load failure.
    readFileSync(bundled, 'utf8');
    // The fixture publishes its results on globalThis, because a bundle with no exports has none.
    requireBundle(bundled);
    return Reflect.get(globalThis, 'stubProbe') as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('optional driver modules in a bundled main process', () => {
  it(
    'requires a missing module as the stand-in, so the kModuleError check finds it',
    async () => {
      const result = await bundleAndLoad(FIXTURE);
      expect(result['snappyMissing']).toBe(true);
      expect(result['kerberosMissing']).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'throws the driver install message when a feature uses a missing module',
    async () => {
      const result = await bundleAndLoad(FIXTURE);
      expect(result['snappyUse']).toBe(
        'Optional module `snappy` not found. Please install it to enable snappy compression',
      );
      expect(result['kerberosUse']).toBe(
        'Optional module `kerberos` not found. Please install it to enable kerberos authentication',
      );
    },
    BUILD_TIMEOUT_MS,
  );
});
