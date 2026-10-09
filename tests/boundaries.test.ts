import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractSpecifiers,
  findBoundaryViolations,
  isSourceFileName,
  packageBoundaries,
  readPackageSources,
} from './support/boundaries';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('extractSpecifiers', () => {
  it('reads static, re-export, side-effect, dynamic and require specifiers', () => {
    const source = [
      "import { ipcRenderer } from 'electron';",
      "import type { Db } from 'mongodb';",
      "export * from 'bson';",
      "import 'react';",
      "const fs = await import('node:fs');",
      "const driver = require('mongodb');",
    ].join('\n');
    expect(extractSpecifiers(source).sort()).toEqual(
      ['electron', 'mongodb', 'bson', 'react', 'node:fs', 'mongodb'].sort(),
    );
  });

  it('ignores specifiers that appear inside a line of code', () => {
    expect(extractSpecifiers("const label = 'import x from electron';")).toEqual([]);
  });
});

describe('isSourceFileName', () => {
  it('accepts ts, tsx, mts and cts sources and rejects other files', () => {
    expect(['a.ts', 'b.tsx', 'c.mts', 'd.cts'].map(isSourceFileName)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['e.json', 'f.md', 'g.js'].map(isSourceFileName)).toEqual([false, false, false]);
  });
});

describe('findBoundaryViolations', () => {
  it('reports each forbidden import for the package that owns the file', () => {
    const violations = findBoundaryViolations([
      {
        path: 'packages/core/src/a.ts',
        source:
          "import { x } from 'electron';\nimport { readFile } from 'fs/promises';\nimport 'react/jsx-runtime';",
      },
      {
        path: 'packages/core/src/b.ts',
        source: "import { useState } from 'react';\nimport { ready } from 'node:fs';",
      },
      { path: 'packages/ui/src/d.ts', source: "import { join } from 'node:path';" },
      {
        path: 'packages/ui/src/e.tsx',
        source: "import { app } from 'electron';\nexport default function App() { return app; }",
      },
      { path: 'packages/storage/src/f.ts', source: "import { DatabaseSync } from 'node:sqlite';" },
      { path: 'packages/storage/src/g.ts', source: "import { createClient } from 'mongodb';" },
      { path: 'packages/mongo-adapter/src/h.ts', source: "import { MongoClient } from 'mongodb';" },
      { path: 'packages/mongo-adapter/src/i.ts', source: "import { useState } from 'react';" },
      { path: 'packages/shell-runtime/src/j.ts', source: "import { app } from 'electron';" },
      { path: 'packages/shell-runtime/src/k.ts', source: "import { useState } from 'react';" },
    ]);
    expect(
      violations.map((violation) => `${violation.packageName} ${violation.specifier}`),
    ).toEqual([
      'core electron',
      'core fs/promises',
      'core react/jsx-runtime',
      'core react',
      'core node:fs',
      'ui node:path',
      'ui electron',
      'storage mongodb',
      'mongo-adapter react',
      'shell-runtime electron',
      'shell-runtime react',
    ]);
  });

  it('allows the imports each package is permitted to use', () => {
    const violations = findBoundaryViolations([
      { path: 'packages/storage/src/a.ts', source: "import { DatabaseSync } from 'node:sqlite';" },
      { path: 'packages/mongo-adapter/src/b.ts', source: "import { MongoClient } from 'mongodb';" },
      { path: 'packages/ui/src/c.tsx', source: "import { useState } from 'react';" },
    ]);
    expect(violations).toEqual([]);
  });

  it('allows relative imports whose names start with a forbidden package name', () => {
    const violations = findBoundaryViolations([
      {
        path: 'packages/core/src/c.ts',
        source:
          "import { domain } from './domain';\nimport { bus } from './events/bus';\nimport { path } from '../react-utils';",
      },
    ]);
    expect(violations).toEqual([]);
  });

  it('checks every package boundary against the repository source', async () => {
    const files = await readPackageSources(repoRoot);
    for (const boundary of packageBoundaries) {
      const prefix = `packages/${boundary.packageName}/src/`;
      expect(files.some((file) => file.path.startsWith(prefix))).toBe(true);
    }
    expect(findBoundaryViolations(files)).toEqual([]);
  });
});
