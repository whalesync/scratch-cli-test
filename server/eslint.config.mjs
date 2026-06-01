// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'scripts/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      // Read choke point for Sync.mappings / mappingsV2 — see
      // src/sync/sync-mapping.schema.ts:parseStoredMappings. Direct
      // prisma.sync.find* calls outside SyncService would skip the v1/v2
      // parse and risk reading stale `mappings` when `mappingsV2` is set.
      // Existence checks that demonstrably don't read mappings may opt out
      // with an explicit `// eslint-disable-next-line no-restricted-syntax`
      // + justification.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='sync'][callee.property.name=/^find(First|Unique|Many|UniqueOrThrow|FirstOrThrow)$/]",
          message:
            'Direct prisma.sync.find* is not allowed outside SyncService — route reads through SyncService (getMappings / getSync / getSyncForExecution / findOneForWorkbook / findAllForWorkbook) so v1/v2 mappings parse correctly. For existence-only checks that do not read mappings, add an eslint-disable with justification.',
        },
      ],
    },
  },
  {
    // The choke point itself plus test fixtures may bypass the rule.
    files: ['src/sync/sync.service.ts', '**/__tests__/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
