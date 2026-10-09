import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, sep } from 'node:path';

export interface PackageBoundary {
  readonly packageName: string;
  readonly forbiddenPackages: readonly string[];
  readonly forbidsNodeBuiltins: boolean;
}

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

export interface BoundaryViolation {
  readonly path: string;
  readonly specifier: string;
  readonly packageName: string;
}

// Mirrors the no-restricted-imports rules in eslint.config.js. Keep both in sync.
export const packageBoundaries: readonly PackageBoundary[] = [
  {
    packageName: 'core',
    forbiddenPackages: ['electron', 'mongodb', 'bson', 'react'],
    forbidsNodeBuiltins: true,
  },
  {
    packageName: 'ui',
    forbiddenPackages: ['electron', 'mongodb', 'bson'],
    forbidsNodeBuiltins: true,
  },
  {
    packageName: 'storage',
    forbiddenPackages: ['electron', 'mongodb', 'react'],
    forbidsNodeBuiltins: false,
  },
  {
    packageName: 'mongo-adapter',
    forbiddenPackages: ['electron', 'react'],
    forbidsNodeBuiltins: false,
  },
];

const bareBuiltins = new Set(builtinModules.filter((name) => !name.startsWith('_')));

const specifierPatterns: readonly RegExp[] = [
  /^\s*import\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of specifierPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) {
    return true;
  }
  const root = specifier.split('/')[0] ?? specifier;
  return bareBuiltins.has(root);
}

function isPackageOrSubpath(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

export function violatesBoundary(specifier: string, boundary: PackageBoundary): boolean {
  if (boundary.forbiddenPackages.some((name) => isPackageOrSubpath(specifier, name))) {
    return true;
  }
  return boundary.forbidsNodeBuiltins && isNodeBuiltin(specifier);
}

function packageNameOf(path: string): string | undefined {
  return /^packages\/([^/]+)\/src\//.exec(path)?.[1];
}

export function findBoundaryViolations(
  files: readonly SourceFile[],
  boundaries: readonly PackageBoundary[] = packageBoundaries,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    const packageName = packageNameOf(file.path);
    const boundary = boundaries.find((candidate) => candidate.packageName === packageName);
    if (boundary === undefined) {
      continue;
    }
    for (const specifier of extractSpecifiers(file.source)) {
      if (violatesBoundary(specifier, boundary)) {
        violations.push({ path: file.path, specifier, packageName: boundary.packageName });
      }
    }
  }
  return violations;
}

export async function readPackageSources(repoRoot: string): Promise<SourceFile[]> {
  const packagesDir = join(repoRoot, 'packages');
  const packageEntries = await readdir(packagesDir, { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const srcDir = join(packagesDir, entry.name, 'src');
    const relativePaths = await readdir(srcDir, { recursive: true });
    for (const relativePath of relativePaths) {
      if (!relativePath.endsWith('.ts')) {
        continue;
      }
      const path = `packages/${entry.name}/src/${relativePath.split(sep).join('/')}`;
      files.push({ path, source: await readFile(join(srcDir, relativePath), 'utf8') });
    }
  }
  return files;
}
