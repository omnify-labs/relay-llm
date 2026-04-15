import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'packages/*/dist/', 'packages/*/node_modules/'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
