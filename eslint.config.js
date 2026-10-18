import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default ts.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      '.dev-data/**',
      '.sandbox-home/**',
      '.npm-cache/**',
      '.electron-cache/**',
      '.electron-builder-cache/**',
      'release/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'scripts/ui-gate.mjs'],
    languageOptions: { globals: globals.browser },
  },
);
