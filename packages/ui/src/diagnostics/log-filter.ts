import type { LogLine } from '@mongo-gui/core';

/** The lowest severity a line may have to be shown. "all" also shows lines without a severity. */
export type MinSeverity = 'all' | 'D' | 'I' | 'W' | 'E';

export interface LogFilter {
  readonly minSeverity: MinSeverity;
  /** "all" or an exact component name. */
  readonly component: string;
  /** Case-insensitive text. Matches the message, the component and the attributes. */
  readonly text: string;
}

export const DEFAULT_LOG_FILTER: LogFilter = { minSeverity: 'all', component: 'all', text: '' };

const RANK: Readonly<Record<string, number>> = { F: 5, E: 4, W: 3, I: 2, D: 1 };

/** The rank of a server severity: "D1" to "D5" count as debug. Unknown severities rank 0. */
export function severityRank(severity: string | undefined): number {
  return RANK[severity?.charAt(0) ?? ''] ?? 0;
}

export interface FilteredLogLine {
  /** Position in the reply, oldest first. Stable across filters. */
  readonly index: number;
  readonly line: LogLine;
}

/** The lines that pass the filter, newest first. */
export function filterLogLines(lines: readonly LogLine[], filter: LogFilter): FilteredLogLine[] {
  const needle = filter.text.trim().toLowerCase();
  const floor = filter.minSeverity === 'all' ? 0 : severityRank(filter.minSeverity);
  const shown: FilteredLogLine[] = [];
  lines.forEach((line, index) => {
    if (filter.minSeverity !== 'all' && severityRank(line.severity) < floor) {
      return;
    }
    if (filter.component !== 'all' && line.component !== filter.component) {
      return;
    }
    if (needle !== '' && !searchableText(line).includes(needle)) {
      return;
    }
    shown.push({ index, line });
  });
  return shown.reverse();
}

/** The distinct components of the lines, sorted. */
export function componentsOf(lines: readonly LogLine[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    if (line.component !== undefined && line.component !== '') {
      names.add(line.component);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function searchableText(line: LogLine): string {
  const attributes = line.attributes === undefined ? '' : JSON.stringify(line.attributes);
  return `${line.message} ${line.component ?? ''} ${attributes}`.toLowerCase();
}
