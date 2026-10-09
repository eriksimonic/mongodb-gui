import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Packages that stay outside the bundle and load from node_modules at runtime. The driver ships
// native optional dependencies, and the mongosh runtime loads its own dependency tree.
const EXTERNAL_PACKAGES = new Set(['mongodb', 'bson']);

function isExternal(id: string): boolean {
  if (id.startsWith('node:') || builtinModules.includes(id)) {
    return true;
  }
  return id.startsWith('@mongosh/') || EXTERNAL_PACKAGES.has(id);
}

// One CommonJS file that a forked Node child or an Electron utility process can load directly.
export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'src/main.ts',
      formats: ['cjs'],
      fileName: () => 'shell-runtime.cjs',
    },
    rollupOptions: {
      external: isExternal,
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
      },
      // zod ships annotation comments that rollup cannot place. They are harmless and removed.
      onwarn(warning, warn) {
        if (warning.code !== 'INVALID_ANNOTATION') {
          warn(warning);
        }
      },
    },
  },
});
