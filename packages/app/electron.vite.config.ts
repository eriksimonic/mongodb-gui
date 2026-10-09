import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { join } from 'node:path';
import { OPTIONAL_MODULES, stubFileFor } from './scripts/optional-modules';

const appRoot = import.meta.dirname;

// The main bundle does not need the optional driver modules. The driver reads some of them while
// it loads, so a missing one would stop the app at start. Each optional module maps to a stand-in
// that answers the driver's kModuleError check and throws the driver's install message when used.
// Aliases apply to the dev build too, which bundles the driver differently.
const optionalModuleAliases = OPTIONAL_MODULES.map((module) => ({
  find: new RegExp(`^${module.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`),
  replacement: join(appRoot, stubFileFor(module.name)),
}));

// Workspace packages ship TypeScript source, which Electron cannot require at run time, so
// the bundle includes them. Their npm dependencies (zod, mongodb) are bundled with them.
const bundledWorkspacePackages = [
  '@mongo-gui/core',
  '@mongo-gui/docker',
  '@mongo-gui/mongo-adapter',
  '@mongo-gui/storage',
];

export default defineConfig(({ command }) => ({
  main: {
    // electron-updater is bundled into the main bundle. It reads app-update.yml from the
    // resources directory at run time, which works inside the asar.
    plugins: [
      externalizeDepsPlugin({ exclude: [...bundledWorkspacePackages, 'electron-updater'] }),
    ],
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
