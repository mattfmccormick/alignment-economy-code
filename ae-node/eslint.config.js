import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

// Backend lint config: Node + TypeScript, no React. This is the money +
// consensus core, so the ruleset is the hard gate in CI. no-explicit-any is
// an error here (unlike the frontends, where it's a tracked warning) because
// an `any` in the protocol path is exactly where a correctness bug hides.
export default defineConfig([
  globalIgnores(['dist', 'data', 'coverage']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Unused code is dead weight; allow leading-underscore opt-out for
      // intentionally-ignored params (Express middleware signatures, etc.).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]);
