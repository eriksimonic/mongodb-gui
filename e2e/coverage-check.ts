// Checks the RPC trace files from the E2E run against the coverage map.
// Run: node e2e/coverage-check.ts <folder of .jsonl trace files>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Coverage } from './coverage-map';

export type Call = { readonly method: string; readonly outcome: string };

/** Reads one trace line. Returns undefined when the line is not a valid call. */
export function parseTraceLine(line: string): Call | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { method, outcome } = value as Record<string, unknown>;
  if (typeof method !== 'string' || typeof outcome !== 'string') return undefined;
  return { method, outcome };
}

/** Returns the problems in the trace lines. An empty list means pass. */
export function checkCoverage(
  map: Readonly<Record<string, Coverage>>,
  traceLines: readonly string[],
): string[] {
  const called = new Set<string>();
  const internalCounts = new Map<string, number>();
  const unknown = new Set<string>();
  const invalid: string[] = [];

  for (const line of traceLines) {
    if (line.trim() === '') continue;
    const call = parseTraceLine(line);
    if (call === undefined) {
      invalid.push(`invalid trace line: ${line}`);
      continue;
    }
    called.add(call.method);
    if (call.outcome === 'INTERNAL') {
      internalCounts.set(call.method, (internalCounts.get(call.method) ?? 0) + 1);
    }
    if (!Object.hasOwn(map, call.method)) unknown.add(call.method);
  }

  const problems: string[] = [];
  for (const [method, coverage] of Object.entries(map)) {
    if ('journey' in coverage && !called.has(method)) {
      problems.push(`${method} is mapped to ${coverage.journey} but was never called`);
    }
  }
  for (const [method, count] of internalCounts) {
    problems.push(
      count === 1 ? `${method} returned INTERNAL` : `${method} returned INTERNAL ${count} times`,
    );
  }
  for (const method of unknown) {
    problems.push(`${method} is not in the coverage map`);
  }
  return [...problems, ...invalid];
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (folder === undefined) {
    console.error('usage: node e2e/coverage-check.ts <folder>');
    process.exitCode = 2;
  } else {
    // Node does not resolve extensionless imports, so the map is loaded with its .ts name.
    const { coverageMap } = (await import(
      new URL('./coverage-map.ts', import.meta.url).href
    )) as typeof import('./coverage-map');

    const files = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);
    if (files.length === 0) {
      console.error(`no .jsonl files in ${folder}`);
      process.exitCode = 1;
    } else {
      const lines = files.flatMap((name) => readFileSync(join(folder, name), 'utf8').split('\n'));
      const calls = lines
        .filter((line) => line.trim() !== '')
        .map(parseTraceLine)
        .filter((call): call is Call => call !== undefined);
      const methods = new Set(calls.map((call) => call.method));
      const journeyCount = Object.values(coverageMap).filter((c) => 'journey' in c).length;
      const problems = checkCoverage(coverageMap, lines);

      console.log(
        `read ${files.length} files, ${calls.length} calls, ${methods.size} distinct methods, ${journeyCount} journey-mapped methods`,
      );
      for (const problem of problems) console.log(problem);
      process.exitCode = problems.length > 0 ? 1 : 0;
    }
  }
}
