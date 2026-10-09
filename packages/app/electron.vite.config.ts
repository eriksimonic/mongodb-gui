import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { join } from 'node:path';

const appRoot = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: join(appRoot, 'out/main'),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
