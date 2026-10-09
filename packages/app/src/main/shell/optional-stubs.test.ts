import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingModule } from '../../../scripts/missing-module';
import { OPTIONAL_MODULES, isOptionalModule, stubFileFor } from '../../../scripts/optional-modules';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SNAPPY_MESSAGE =
  'Optional module `snappy` not found. Please install it to enable snappy compression';

describe('optional module stand-ins', () => {
  it.each(OPTIONAL_MODULES.map((module) => [module.name, module.message]))(
    'gives %s a stand-in file that carries the driver message',
    (name, message) => {
      const path = resolve(APP_ROOT, stubFileFor(name));
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(message);
    },
  );

  it('answers the driver kModuleError check with the install message', () => {
    const stub = missingModule(SNAPPY_MESSAGE);
    expect('kModuleError' in stub).toBe(true);
    expect((stub['kModuleError'] as Error).message).toBe(SNAPPY_MESSAGE);
  });

  it('throws the install message when a feature reads the module', () => {
    const stub = missingModule(SNAPPY_MESSAGE);
    expect(() => stub['compress']).toThrow(SNAPPY_MESSAGE);
    expect(() => {
      stub['compress'] = 1;
    }).toThrow(SNAPPY_MESSAGE);
  });

  it('lets the loader read the keys it checks while it wraps a module', () => {
    const stub = missingModule(SNAPPY_MESSAGE);
    expect(stub['default']).toBeUndefined();
    expect(stub['__esModule']).toBeUndefined();
    expect(stub['version']).toBeUndefined();
  });

  it('matches a module and its subpaths, and nothing else', () => {
    expect(isOptionalModule('kerberos')).toBe(true);
    expect(isOptionalModule('kerberos/package.json')).toBe(true);
    expect(isOptionalModule('mongodb')).toBe(false);
    expect(isOptionalModule('kerberosish')).toBe(false);
  });
});
