import js from '@eslint/js';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

const nodeBuiltinNames = builtinModules.filter((name) => !name.startsWith('_'));

function importBoundary({ packages, nodeBuiltins }) {
  const patterns = packages.map((name) => ({
    group: [name, `${name}/**`],
    message: `Package boundary: this package may not import "${name}". See docs/PLAN.md section 2.2.`,
  }));
  if (nodeBuiltins) {
    patterns.push({
      group: [
        'node:*',
        'node:*/**',
        ...nodeBuiltinNames,
        ...nodeBuiltinNames.map((name) => `${name}/**`),
      ],
      message: 'Package boundary: this package may not import Node built-in modules.',
    });
  }
  return ['error', { patterns }];
}

export default [
  {
    ignores: ['**/dist/**', '**/coverage/**', 'out/**', '.vite/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    ignores: ['**/*.config.ts'],
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
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'mongodb', 'bson', 'react'],
        nodeBuiltins: true,
      }),
    },
  },
  {
    files: ['packages/ui/src/**/*.ts'],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'mongodb', 'bson'],
        nodeBuiltins: true,
      }),
    },
  },
  {
    files: ['packages/storage/src/**/*.ts'],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'mongodb', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
  {
    files: ['packages/mongo-adapter/src/**/*.ts'],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
];
