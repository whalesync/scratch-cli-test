import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';
import { createRequire } from 'module';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const noZustandStoreDestructuring = require('./eslint-rules/no-zustand-store-destructuring.js');

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      local: {
        rules: {
          'no-zustand-store-destructuring': noZustandStoreDestructuring,
        },
      },
    },
    rules: {
      'local/no-zustand-store-destructuring': [
        'error',
        {
          // Match hooks ending with "Store" (default pattern)
          hookPattern: '^use.*Store$',
          // You can also specify specific hook names if needed:
          // hookNames: ['useWorkbookEditorUIStore', 'useLayoutManagerStore'],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lodash',
              message: `Use "import fnName from 'lodash/functionName' instead`,
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
];

export default eslintConfig;
