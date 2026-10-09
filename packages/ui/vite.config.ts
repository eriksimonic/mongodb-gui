import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Browser-only dev server. window.mongoGui is absent here, so App shows the fallback message.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
