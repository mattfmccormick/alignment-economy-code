import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate from vite.config.ts on purpose: the app build pulls in the PWA
// plugin (service-worker generation), which has no business running under the
// test runner. Here we only need the React JSX transform plus a jsdom DOM so
// component/flow tests can render and interact with pages.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Pure-logic tests (crypto, formatting, ledger) run fine under jsdom too,
    // so a single environment covers both them and the component tests.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
