import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractSpecifiers,
  findBoundaryViolations,
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

describe('findBoundaryViolations', () => {
  it('reports each forbidden import for the package that owns the file', () => {
    const violations = findBoundaryViolations([
      {
        path: 'packages/core/src/a.ts',
        source:
          "import { x } from 'electron';\nimport { readFile } from 'fs/promises';\nimport 'react/jsx-runtime';",
      },
      { path: 'packages/ui/src/b.ts', source: "import { join } from 'node:path';" },
      { path: 'packages/storage/src/c.ts', source: "import { DatabaseSync } from 'node:sqlite';" },
      { path: 'packages/storage/src/d.ts', source: "import { createClient } from 'mongodb';" },
      { path: 'packages/mongo-adapter/src/e.ts', source: "import { MongoClient } from 'mongodb';" },
      { path: 'packages/mongo-adapter/src/f.ts', source: "import { useState } from 'react';" },
      { path: 'packages/shell-runtime/src/g.ts', source: "import { app } from 'electron';" },
    ]);
    expect(
      violations.map((violation) => `${violation.packageName} ${violation.specifier}`),
    ).toEqual([
      'core electron',
      'core fs/promises',
      'core react/jsx-runtime',
      'ui node:path',
      'storage mongodb',
      'mongo-adapter react',
    ]);
  });

  it('allows the imports each package is permitted to use', () => {
    const violations = findBoundaryViolations([
      { path: 'packages/storage/src/a.ts', source: "import { DatabaseSync } from 'node:sqlite';" },
      { path: 'packages/mongo-adapter/src/b.ts', source: "import { MongoClient } from 'mongodb';" },
      { path: 'packages/ui/src/c.ts', source: "import { useState } from 'react';" },
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
