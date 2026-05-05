import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Critical for the packaged Electron build. Without this, vite emits an
  // index.html that references assets at /assets/index-abc.js (absolute
  // path). Electron loads via file://, so the browser resolves that to
  // file:///assets/index-abc.js — the root of the user's filesystem, not
  // the bundle — and the page renders blank because no JS loads.
  // base: './' makes paths relative: ./assets/index-abc.js, which works
  // under file:// and http:// alike. Same fix is in ae-miner/vite.config.ts.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'favicon.svg'],
      manifest: {
        name: 'Alignment Economy Wallet',
        short_name: 'AE Wallet',
        description: 'Send points, vouch, and manage your participant wallet on the Alignment Economy network.',
        id: '/?source=pwa',
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        theme_color: '#1b2a4a',
        background_color: '#0f1a2e',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      // Enable the install prompt during `npm run dev` so we don't need a
      // production build to test installation locally.
      devOptions: { enabled: true, type: 'module' },
      workbox: {
        // Don't cache /api or /ws — those must always hit the live backend
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
