// Fails the build when the main bundle loads a module that is not electron, a Node built-in or an
// optional-module stand-in. The main process is one file, so any other import is a module that
// is missing from the packaged app. Run after electron-vite build.
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A line that starts a comment. Module names in comments are not loaded.
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

// Each pattern captures the module name in its first group.
const LOAD_PATTERNS: readonly RegExp[] = [
  // import x from "m", import { a } from "m", import "m". The statement starts the line.
  /^\s*import\s*(?:[^;'"`]*?\sfrom\s*)?["']([^"']+)["']/gm,
  // export { a } from "m" and export * from "m".
  /^\s*export\s[^;'"`]*?\sfrom\s*["']([^"']+)["']/gm,
  // import("m") in code.
  /(?<![\w$.])import\(\s*["']([^"']+)["']\s*\)/g,
  // require("m"), and require2("m") for the require the main bundle's banner defines.
  /(?:^|[=(,;:?!&|{[]|\breturn)\s*require\w*\(\s*["']([^"']+)["']\s*\)/gm,
];

/**
 * Returns the module names the bundle source loads that are not allowed. The allowed names are
 * electron, electron/*, Node built-ins with or without the node: prefix, and the absolute paths in
 * standInDirectory. The optional-module aliases point into that folder (scripts/stubs).
 */
export function forbiddenModules(source: string, standInDirectory: string): string[] {
  const code = source
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
  const found: string[] = [];
  for (const pattern of LOAD_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && !isAllowed(name, standInDirectory)) found.push(name);
    }
  }
  return [...new Set(found)];
}

function isAllowed(name: string, standInDirectory: string): boolean {
  if (name === 'electron' || name.startsWith('electron/')) return true;
  if (isBuiltin(name)) return true;
  return name.startsWith(`${standInDirectory}/`);
}

const appRoot = resolve(import.meta.dirname, '..');

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const standInDirectory = join(appRoot, 'scripts/stubs');
  const bundle = join(appRoot, 'out/main/index.js');
  const source = readFileSync(bundle, 'utf8');
  const forbidden = forbiddenModules(source, standInDirectory);
  if (forbidden.length > 0) {
    console.error(
      `${bundle} loads modules other than electron and Node built-ins: ${forbidden.join(', ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log('main bundle: loads only electron and Node built-ins');
  }
}
