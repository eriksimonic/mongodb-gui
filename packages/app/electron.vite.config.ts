import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { join } from 'node:path';
import { optionalModuleAliases, optionalModuleCommonjsOptions } from './scripts/main-build';

const appRoot = import.meta.dirname;

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
      alias: optionalModuleAliases(appRoot),
    },
    build: {
      outDir: join(appRoot, 'out/main'),
      // The dev server empties this folder when it starts. The shell runtime bundle is built into
      // the same folder before dev starts, so dev keeps the folder as it is.
      emptyOutDir: command === 'build',
      commonjsOptions: optionalModuleCommonjsOptions(),
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
      // esbuild minifies the renderer. Monaco and the language workers are most of its size.
      minify: 'esbuild',
    },
  },
}));
