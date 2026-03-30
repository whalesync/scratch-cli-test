// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'out/**', 'dist/**', 'postcss.config.cjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // TypeScript strictness — match client/server
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',

      // React hooks
      ...reactHooks.configs.recommended.rules,

      // React refresh — warn on non-component exports from component files
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Import restrictions — match client
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lodash',
              message: `Use "import fnName from 'lodash/functionName'" instead`,
            },
          ],
          patterns: [
            {
              group: ['**/packages/shared-types/**'],
              message: 'Use "@spinner/shared-types" instead of relative imports to packages/shared-types',
            },
          ],
        },
      ],
    },
  },
);
