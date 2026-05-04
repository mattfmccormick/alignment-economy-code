import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
