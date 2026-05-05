import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Block explorer dev server. Proxy /api/v1 + /ws to the local ae-node so
// the SDK's relative-path mode works in dev without CORS surprises.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    proxy: {
      '/api/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true, changeOrigin: true },
    },
  },
});
