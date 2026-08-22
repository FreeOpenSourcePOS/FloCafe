import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['main/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Shared print kernel (#441): purity boundary — types + pure functions
    // only. No Node builtins, frameworks, or cross-boundary imports; see
    // shared/print/README.md. Also enforced by tests/kernel-purity.test.ts.
    files: ['shared/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              'node:*', 'fs', 'path', 'crypto', 'net', 'http', 'https', 'os', 'child_process',
              'electron', 'react', 'react-dom', 'express', 'next',
              'frontend/**', 'main/**', '@/__', '@countries',
            ],
            message: 'shared/print is a pure kernel: no IO or framework imports (see shared/print/README.md).',
          },
        ],
      }],
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'release/', 'frontend/', 'tests/'],
  },
];
