import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { join } from 'node:path';

const appRoot = import.meta.dirname;

// Workspace packages ship TypeScript source, which Electron cannot require at run time, so
// the bundle includes them. Their npm dependencies (zod, mongodb) are bundled with them.
const bundledWorkspacePackages = [
  '@mongo-gui/core',
  '@mongo-gui/mongo-adapter',
  '@mongo-gui/storage',
];

export default defineConfig({
  main: {
    // electron-updater is bundled into the main bundle. It reads app-update.yml from the
    // resources directory at run time, which works inside the asar.
    plugins: [
      externalizeDepsPlugin({ exclude: [...bundledWorkspacePackages, 'electron-updater'] }),
    ],
    build: {
      outDir: join(appRoot, 'out/main'),
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
});
