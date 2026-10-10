import {
  HIGH_RATIO_THRESHOLD,
  type PlanStage,
  type PlanWarning,
  type PlanWarningSeverity,
  type StageCategory,
  type StageInfo,
  type StageMetric,
} from '@mongo-gui/core';

const LOCALE = 'en-US';
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const BYTE_STEP = 1024;

/** A count with thousands separators. */
export function formatCount(value: number): string {
  return value.toLocaleString(LOCALE);
}

/** A duration: milliseconds under a second, seconds from there up. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} ms`;
  }
  return `${(ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 2 })} s`;
}

/** A size in bytes, in the largest binary unit that keeps the value under 1024. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: digits })} ${BYTE_UNITS[unit]}`;
}

export interface MetricItem {
  readonly key: StageMetric;
  readonly label: string;
  readonly text: string;
  /** Spill counters are highlighted when they are non-zero. */
  readonly highlight: boolean;
}

/**
 * The metrics the catalogue marks meaningful for a stage, in catalogue order, for the values the
 * stage reports. The index is shown as a badge, so it is not a metric item.
 */
export function stageMetricItems(stage: PlanStage, info: StageInfo): MetricItem[] {
  const items: MetricItem[] = [];
  for (const key of info.metrics) {
    const item = metricItem(stage, key, info);
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items;
}

/**
 * Whether the stage reports its time as an estimate. Stages inside the plan carry only
 * executionTimeMillisEstimate, and the top-level execution block carries executionTimeMillis.
 */
export function timeIsEstimate(stage: PlanStage): boolean {
  const raw =
    typeof stage.raw === 'object' && stage.raw !== null
      ? (stage.raw as Record<string, unknown>)
      : {};
  return (
    raw['executionTimeMillisEstimate'] !== undefined && raw['executionTimeMillis'] === undefined
  );
}

function metricItem(stage: PlanStage, key: StageMetric, info: StageInfo): MetricItem | undefined {
  const build = (label: string, text: string, highlight = false): MetricItem => ({
    key,
    label,
    text,
    highlight,
  });
  switch (key) {
    case 'docsExamined':
      return stage.docsExamined === undefined
        ? undefined
        : build('Docs', formatCount(stage.docsExamined));
    case 'keysExamined':
      return stage.keysExamined === undefined
        ? undefined
        : build('Keys', formatCount(stage.keysExamined));
    case 'nReturned':
      return stage.nReturned === undefined
        ? undefined
        : build('Returned', formatCount(stage.nReturned));
    case 'executionTimeMs':
      return stage.executionTimeMs === undefined
        ? undefined
        : build(
            timeIsEstimate(stage) ? 'Time (est.)' : 'Time',
            formatDuration(stage.executionTimeMs),
          );
    case 'works':
      return stage.works === undefined ? undefined : build('Works', formatCount(stage.works));
    // A sort reports the bytes it sorted, and a group reports its largest accumulator. Neither is
    // the memory the stage holds, so the label names what the number is. Not a spill signal.
    case 'memUsageBytes':
      return stage.memUsageBytes === undefined
        ? undefined
        : build(
            info.category === 'sort' ? 'Data sorted' : 'Memory',
            formatBytes(stage.memUsageBytes),
          );
    case 'memLimitBytes':
      return stage.memLimitBytes === undefined
        ? undefined
        : build('Memory limit', formatBytes(stage.memLimitBytes));
    case 'usedDisk':
      return stage.usedDisk === undefined
        ? undefined
        : build('Used disk', stage.usedDisk ? 'yes' : 'no', stage.usedDisk);
    case 'spills':
      return stage.spills === undefined
        ? undefined
        : build('Spills', formatCount(stage.spills), stage.spills > 0);
    case 'spilledBytes':
      return stage.spilledBytes === undefined
        ? undefined
        : build('Spilled', formatBytes(stage.spilledBytes), stage.spilledBytes > 0);
    case 'chunkSkips':
      return stage.chunkSkips === undefined
        ? undefined
        : build('Orphans skipped', formatCount(stage.chunkSkips));
    case 'index':
      return undefined;
  }
}

export interface RatioView {
  readonly ratio: number;
  readonly text: string;
  readonly high: boolean;
}

const SCAN_OR_FETCH: ReadonlySet<StageCategory> = new Set(['scan', 'fetch']);

/**
 * Documents examined per document returned, for a scan or a fetch that reports both. A ratio
 * above the warning threshold is marked high.
 */
export function examinedRatio(stage: PlanStage, info: StageInfo): RatioView | undefined {
  // $cursor is the input of an aggregate, not a scan of its own, so it gets no ratio.
  if (!SCAN_OR_FETCH.has(info.category) || stage.name === '$cursor') {
    return undefined;
  }
  const examined = stage.docsExamined;
  const returned = stage.nReturned;
  if (examined === undefined || returned === undefined) {
    return undefined;
  }
  if (returned === 0) {
    return {
      ratio: examined,
      text: `${formatCount(examined)} examined, none returned`,
      high: examined > 0,
    };
  }
  const ratio = examined / returned;
  return {
    ratio,
    text: `${ratio.toLocaleString(LOCALE, { maximumFractionDigits: 1 })}x examined per returned`,
    high: ratio > HIGH_RATIO_THRESHOLD,
  };
}

/** The error message of a shard that failed, from the shard entry the server returned. */
export function shardErrorMessage(raw: unknown): string {
  const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const error = entry['error'];
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['errmsg'];
    if (typeof message === 'string') {
      return message;
    }
  }
  return error === undefined ? 'The shard failed.' : JSON.stringify(error);
}

const SEVERITY_ORDER: Readonly<Record<PlanWarningSeverity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Warnings with the most severe first. Equal severities keep the order the core gave them. */
export function sortWarnings(warnings: readonly PlanWarning[]): PlanWarning[] {
  return warnings
    .map((warning, index) => ({ warning, index }))
    .sort(
      (left, right) =>
        SEVERITY_ORDER[left.warning.severity] - SEVERITY_ORDER[right.warning.severity] ||
        left.index - right.index,
    )
    .map((entry) => entry.warning);
}

export interface TextSpan {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column. */
  readonly column: number;
  readonly length: number;
}

/**
 * Every case-insensitive occurrence of the query in the text, in reading order. Columns are
 * UTF-16 offsets into the line, the same units the editor uses, so the match lands on the text.
 */
export function findTextMatches(text: string, query: string): TextSpan[] {
  if (query === '') {
    return [];
  }
  const pattern = new RegExp(escapeRegExp(query), 'gi');
  const matches: TextSpan[] = [];
  text.split('\n').forEach((lineText, lineIndex) => {
    for (const found of lineText.matchAll(pattern)) {
      matches.push({
        line: lineIndex + 1,
        column: (found.index ?? 0) + 1,
        length: found[0].length,
      });
    }
  });
  return matches;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The index of the next match, wrapping from the last to the first. */
export function nextMatchIndex(current: number, count: number): number {
  return count === 0 ? -1 : (current + 1) % count;
}

/** The index of the previous match, wrapping from the first to the last. */
export function previousMatchIndex(current: number, count: number): number {
  return count === 0 ? -1 : (current - 1 + count) % count;
}
