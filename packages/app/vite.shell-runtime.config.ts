import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { OPTIONAL_MODULES, isOptionalModule } from './build/optional-modules';

// The shell runtime is a second main-process bundle. It runs in a utility process or a forked
// Node child, outside the app's own module graph, so it is built as one CommonJS file with its
// workspace and npm dependencies inside. electron-vite builds the app itself. This config
// builds only the runtime entry, into the same out/main folder.
const appRoot = import.meta.dirname;

const BUILTIN_MODULES = new Set(builtinModules);

function isExternal(id: string): boolean {
  if (id.startsWith('node:') || BUILTIN_MODULES.has(id)) {
    return true;
  }
  return isOptionalModule(id);
}

// Some optional modules are required when the bundle loads. A missing one must not stop the
// runtime, so their top-level requires read the module through this guard. It returns undefined
// for a module that is not installed and rethrows any other failure.
const OPTIONAL_REQUIRE_BANNER = `function __optionalRequire(name) {
  try {
    return require(name);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}`;

// Rewrites a top-level "const x = require(\"socks\");" line into the guarded form. Requires inside
// functions already sit under the driver's own try blocks and stay as they are.
function guardOptionalRequires(): Plugin {
  return {
    name: 'guard-optional-requires',
    renderChunk(code) {
      let next = code;
      for (const name of OPTIONAL_MODULES) {
        const pattern = new RegExp(
          `^(const [\\w$]+ = )require\\(['"]${escapeRegExp(name)}['"]\\);$`,
          'm',
        );
        if (!pattern.test(next)) {
          continue;
        }
        next = next.replace(pattern, `$1__optionalRequire("${name}");`);
      }
      return { code: next, map: null };
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  plugins: [guardOptionalRequires()],
  root: appRoot,
  build: {
    target: 'node24',
    outDir: join(appRoot, 'out/main'),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: join(appRoot, '../shell-runtime/src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'shell-runtime.cjs',
    },
    rollupOptions: {
      external: isExternal,
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
        banner: OPTIONAL_REQUIRE_BANNER,
      },
      onwarn(warning, warn) {
        // zod ships annotation comments that rollup cannot place. They are harmless and removed.
        if (warning.code !== 'INVALID_ANNOTATION') {
          warn(warning);
        }
      },
    },
  },
});
