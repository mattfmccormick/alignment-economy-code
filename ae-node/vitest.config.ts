import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    external: ['node:sqlite'],
    noExternal: true,
  },
  test: {
    globals: true,
    testTimeout: 30000,
    pool: 'forks',
  },
});
