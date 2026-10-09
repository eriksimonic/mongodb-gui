import { join } from 'node:path';
import { OPTIONAL_MODULES, stubFileFor } from './optional-modules';

// Settings the main build and its tests share, so the test builds a fixture the same way the app
// builds the driver.

// Each optional module maps to its stand-in file. The alias applies to the dev build too, which
// bundles the driver differently.
export function optionalModuleAliases(appRoot: string) {
  return OPTIONAL_MODULES.map((module) => ({
    find: new RegExp(`^${module.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`),
    replacement: join(appRoot, stubFileFor(module.name)),
  }));
}

const STUB_DIRECTORY = '/scripts/stubs/';

// A stand-in is an ES module with a default export. Without this option the commonjs plugin wraps
// that default in a namespace object, so a require of the module returns the namespace. The
// driver's kModuleError check then misses the stand-in. This option makes require return the
// default export, which is the stand-in itself.
export function optionalModuleCommonjsOptions() {
  return {
    requireReturnsDefault: (id: string) => id.replace(/\\/g, '/').includes(STUB_DIRECTORY),
  };
}
