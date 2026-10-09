import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { join } from 'node:path';
import { OPTIONAL_MODULES } from './build/optional-modules';

const appRoot = import.meta.dirname;

// The main bundle has no use for the optional driver modules. The driver reads some of them when
// it loads, so a missing one would stop the app at start. Each one maps to an empty stand-in, the
// way the production bundle already treated the zstd module. The driver reports a missing feature
// only when a command asks for it. Aliasing covers the dev build too, which bundles differently.
const EMPTY_MODULE = join(appRoot, 'build/empty-module.js');

const optionalModuleAliases = OPTIONAL_MODULES.map((name) => ({
  find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`),
  replacement: EMPTY_MODULE,
}));

// Workspace packages ship TypeScript source, which Electron cannot require at run time, so
// the bundle includes them. Their npm dependencies (zod, mongodb) are bundled with them.
const bundledWorkspacePackages = [
  '@mongo-gui/core',
  '@mongo-gui/mongo-adapter',
  '@mongo-gui/storage',
];

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePackages })],
    resolve: {
      alias: optionalModuleAliases,
    },
    build: {
      outDir: join(appRoot, 'out/main'),
      // The dev server empties this folder when it starts. The shell runtime bundle is built into
      // the same folder before dev starts, so dev keeps the folder as it is.
      emptyOutDir: command === 'build',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePackages })],
    build: {
      outDir: join(appRoot, 'out/preload'),
      // Sandboxed preload scripts must be CommonJS. The package is type module,
      // so the file gets a .cjs extension to stay CommonJS under Node's rules.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: join(appRoot, 'src/renderer'),
    plugins: [react()],
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    build: {
      outDir: join(appRoot, 'out/renderer'),
    },
  },
}));
