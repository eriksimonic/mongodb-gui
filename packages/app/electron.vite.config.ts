import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { join } from 'node:path';
import { optionalModuleAliases, optionalModuleCommonjsOptions } from './scripts/main-build';

const appRoot = import.meta.dirname;

// Workspace packages ship TypeScript source, which Electron cannot require at run time, so the
// preload bundle includes them. The main bundle includes everything, so it does not use this list.
const bundledWorkspacePackages = [
  '@mongo-gui/core',
  '@mongo-gui/docker',
  '@mongo-gui/mongo-adapter',
  '@mongo-gui/storage',
];

export default defineConfig(({ command }) => ({
  main: {
    // The main process is one bundle, out/main/index.js. Every npm dependency and workspace
    // package is built into it, so the app loads no module from node_modules at run time.
    // electron-vite externalizes the dependencies of this build by default. externalizeDeps is
    // off, so only the defaults stay external: electron, electron/* and the Node built-ins.
    // electron-updater reads app-update.yml from the resources directory, which is not a module.
    resolve: {
      alias: optionalModuleAliases(appRoot),
    },
    build: {
      externalizeDeps: false,
      outDir: join(appRoot, 'out/main'),
      // The dev server empties this folder when it starts. The shell runtime bundle is built into
      // the same folder before dev starts, so dev keeps the folder as it is.
      emptyOutDir: command === 'build',
      commonjsOptions: optionalModuleCommonjsOptions(),
      rollupOptions: {
        output: {
          // The bundle is an ES module, where require is not defined. The bundler keeps a few
          // CommonJS require calls from the driver and sax, and they run at run time (SCRAM-SHA-1
          // uses require("crypto")). This line gives them a require that loads the built-ins.
          banner:
            "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
        },
      },
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
