import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Browser-only dev server. Runs the UI against the mock api from browser-main.tsx.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
