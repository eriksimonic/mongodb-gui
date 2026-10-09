import js from '@eslint/js';
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
    ignores: ['**/dist/**', '**/coverage/**', 'out/**', '.vite/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: [SOURCE_GLOB],
    ignores: ['**/*.config.{ts,mts,js,mjs}'],
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
    files: ['packages/shell-runtime/src/' + SOURCE_GLOB],
    rules: {
      'no-restricted-imports': importBoundary({
        packages: ['electron', 'react'],
        nodeBuiltins: false,
      }),
    },
  },
];
