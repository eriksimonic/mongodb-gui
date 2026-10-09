import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts}';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const nodeBuiltinNames = builtinModules.filter((name) => !name.includes(':'));
const nodeBuiltinRegex = `^(node:.*|(${nodeBuiltinNames.map(escapeRegExp).join('|')})(/.*)?)$`;

function packageRegex(names) {
  return `^(${names.map(escapeRegExp).join('|')})(/.*)?$`;
}

function importBoundary({ packages, nodeBuiltins }) {
  const patterns = [
    {
      regex: packageRegex(packages),
      message: `Package boundary: this package may not import ${packages.join(', ')}. See docs/PLAN.md section 2.2.`,
    },
  ];
  if (nodeBuiltins) {
    patterns.push({
      regex: nodeBuiltinRegex,
      message:
        'Package boundary: this package may not import Node built-in modules. See docs/PLAN.md section 2.2.',
    });
  }
  return ['error', { patterns }];
}

export default [
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/out/**', '**/.vite/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: [SOURCE_GLOB],
    ignores: ['**/*.config.{ts,mts,js,mjs}', '**/*.stories.tsx', '**/.storybook/*.{ts,tsx}'],
    rules: {
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: false,
            defaultFrom: true,
            namedFrom: false,
            namespaceFrom: false,
          },
        },
      ],
    },
  },
  {
    // Playwright loads its config and global setup through their default exports.
    files: ['e2e/playwright.config.ts', 'e2e/global-setup.ts'],
    rules: {
      'no-restricted-exports': 'off',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-refresh/only-export-components': 'error',
    },
  },
  {
    // Storybook stories export meta and story objects next to the component.
    files: ['**/*.stories.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['packages/core/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'mongodb', 'bson', 'react'],
        nodeBuiltins: true,
      }),
    },
  },
  {
    files: ['packages/ui/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'mongodb', 'bson'],
        nodeBuiltins: true,
      }),
    },
  },
  {
    files: ['packages/storage/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'mongodb', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
  {
    files: ['packages/mongo-adapter/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
  {
    files: ['packages/docker/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
  {
    files: ['packages/shell-runtime/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
];
