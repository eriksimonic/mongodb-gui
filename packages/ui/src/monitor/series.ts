import {
  REPLICA_MEMBER_SEGMENT,
  type MonitorSample,
  type PanelSpec,
  type SeriesSpec,
  type SeriesUnit,
} from '@mongo-gui/core';

export const MONITOR_RANGES = ['5m', '15m', '1h'] as const;
export type MonitorRange = (typeof MONITOR_RANGES)[number];

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
// A gap longer than this many intervals is an outage. The line breaks there instead of bridging it.
const GAP_FACTOR = 2.5;
// A chart draws at most this many lines. Replica lag past the cap folds into "Other".
const MAX_LINES = 8;
const OTHER_LABEL = 'Other';
export const MEMBER_KEY_SEPARATOR = '@';

export const RANGE_MS: Readonly<Record<MonitorRange, number>> = {
  '5m': 5 * MS_PER_MINUTE,
  '15m': 15 * MS_PER_MINUTE,
  '1h': 60 * MS_PER_MINUTE,
};

export const RANGE_LABELS: Readonly<Record<MonitorRange, string>> = {
  '5m': '5 min',
  '15m': '15 min',
  '1h': '1 h',
};

/** Spacing of x-axis labels for each range: one per minute, per three minutes, per ten minutes. */
export const RANGE_TICK_SECONDS: Readonly<Record<MonitorRange, number>> = {
  '5m': 60,
  '15m': 180,
  '1h': 600,
};

/** One line in a chart. `values` holds null where the server reported nothing or a gap starts. */
export interface SeriesLine {
  readonly key: string;
  readonly label: string;
  readonly unit: SeriesUnit;
  readonly values: readonly (number | null)[];
}

/** The shared time axis of a run of samples. Gap breaks add a point with no sample. */
export interface Timeline {
  /** Epoch seconds, oldest first. */
  readonly times: readonly number[];
  readonly points: readonly Point[];
}

/** The headline numbers for the stat tiles, taken from one sample. */
export interface MonitorHeadline {
  readonly uptimeSeconds: number | undefined;
  readonly currentConnections: number | undefined;
  readonly cacheFillPercent: number | undefined;
  readonly opsPerSecond: number | undefined;
  readonly oplogWindowSeconds: number | undefined;
}

/**
 * Merges incoming samples into a list, drops duplicates by time, and keeps only the samples
 * within retentionMs of the newest one. When the incoming samples are all newer and in order,
 * they are appended without sorting.
 */
export function mergeSamples(
  existing: readonly MonitorSample[],
  incoming: readonly MonitorSample[],
  retentionMs: number,
): MonitorSample[] {
  const last = existing.at(-1);
  const appendOnly = incoming.every((sample, index) => {
    const previous = index === 0 ? last : incoming[index - 1];
    return previous === undefined || Date.parse(sample.at) > Date.parse(previous.at);
  });
  if (appendOnly) {
    return trimToRetention([...existing, ...incoming], retentionMs);
  }
  const byTime = new Map<string, MonitorSample>();
  for (const sample of [...existing, ...incoming]) {
    byTime.set(sample.at, sample);
  }
  const sorted = [...byTime.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return trimToRetention(sorted, retentionMs);
}

function trimToRetention(sorted: MonitorSample[], retentionMs: number): MonitorSample[] {
  const newest = sorted.at(-1);
  if (newest === undefined) {
    return [];
  }
  const cutoff = Date.parse(newest.at) - retentionMs;
  let start = 0;
  while (start < sorted.length && Date.parse(sorted[start]?.at ?? '') < cutoff) {
    start += 1;
  }
  return start === 0 ? sorted : sorted.slice(start);
}

/** The samples within a range, measured back from the newest sample rather than the clock. */
export function rangeSamples(
  samples: readonly MonitorSample[],
  range: MonitorRange,
): MonitorSample[] {
  const newest = samples.at(-1);
  if (newest === undefined) {
    return [];
  }
  const cutoff = Date.parse(newest.at) - RANGE_MS[range];
  return samples.filter((sample) => Date.parse(sample.at) >= cutoff);
}

/** The usual spacing between samples, from the median gap. One second when there are fewer than two. */
export function inferIntervalMs(samples: readonly MonitorSample[]): number {
  const gaps = samples
    .slice(1)
    .map((sample, index) => Date.parse(sample.at) - Date.parse(samples[index]?.at ?? sample.at))
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? MS_PER_SECOND;
}

interface Point {
  readonly time: number;
  /** Undefined marks a gap break, where every line gets null. */
  readonly sample: MonitorSample | undefined;
}

/**
 * A pair of samples is a gap when its spacing exceeds 2.5 times the spacing around it. The spacing
 * around a pair is the larger of its neighbouring pairs, and never less than the current interval.
 * The local spacing keeps history recorded at an older interval intact after the interval changes.
 */
function pointsOf(samples: readonly MonitorSample[], intervalMs: number): Point[] {
  const times = samples.map((sample) => Date.parse(sample.at));
  const deltas = times.slice(1).map((time, index) => time - (times[index] ?? time));
  const points: Point[] = [];
  samples.forEach((sample, index) => {
    const time = times[index] ?? 0;
    if (index > 0) {
      const delta = deltas[index - 1] ?? 0;
      const neighbours = [deltas[index - 2], deltas[index]].filter(
        (value): value is number => value !== undefined,
      );
      const local = Math.max(intervalMs, ...neighbours);
      if (delta > GAP_FACTOR * local) {
        const breakTime = (times[index - 1] ?? time) + intervalMs;
        points.push({ time: breakTime / MS_PER_SECOND, sample: undefined });
      }
    }
    points.push({ time: time / MS_PER_SECOND, sample });
  });
  return points;
}

/** The shared time axis for every chart on the dashboard, with a break at each outage. */
export function timelineOf(
  samples: readonly MonitorSample[],
  intervalMs: number = inferIntervalMs(samples),
): Timeline {
  const points = pointsOf(samples, intervalMs);
  return { times: points.map((point) => point.time), points };
}

/**
 * The lines of one panel. A series with a replica member segment yields one line per member
 * that reports it, and the members past the cap fold into "Other". A line the window never has a
 * value for is left out, so an absent series does not show an empty legend entry.
 */
export function panelLines(timeline: Timeline, panel: PanelSpec): SeriesLine[] {
  return panel.series.flatMap((spec) => {
    if (isReplicaLag(spec)) {
      return memberLines(timeline, spec);
    }
    const line = lineOf(
      timeline,
      spec.id,
      spec.label,
      spec.unit,
      (sample) => sample.series[spec.id],
    );
    return hasValue(line) ? [line] : [];
  });
}

function isReplicaLag(spec: SeriesSpec): boolean {
  return spec.path[0] === 'repl' && spec.path[2] === REPLICA_MEMBER_SEGMENT;
}

function lineOf(
  timeline: Timeline,
  key: string,
  label: string,
  unit: SeriesUnit,
  pick: (sample: MonitorSample) => number | undefined,
): SeriesLine {
  return {
    key,
    label,
    unit,
    values: timeline.points.map((point) =>
      point.sample === undefined ? null : (pick(point.sample) ?? null),
    ),
  };
}

function hasValue(line: SeriesLine): boolean {
  return line.values.some((value) => value !== null);
}

/** One line per member that reports the series, in the order the newest sample lists them. */
function memberLines(timeline: Timeline, spec: SeriesSpec): SeriesLine[] {
  const prefix = `${spec.id}${MEMBER_KEY_SEPARATOR}`;
  const names = memberNames(timeline, prefix);
  const folded = names.length > MAX_LINES ? names.slice(MAX_LINES - 1) : [];
  const shown = folded.length > 0 ? names.slice(0, MAX_LINES - 1) : names;
  const lines = shown.map((name) =>
    lineOf(
      timeline,
      `${prefix}${name}`,
      name,
      spec.unit,
      (sample) => sample.series[`${prefix}${name}`],
    ),
  );
  if (folded.length > 0) {
    lines.push({
      key: `${spec.id}${MEMBER_KEY_SEPARATOR}${OTHER_LABEL}`,
      label: OTHER_LABEL,
      unit: spec.unit,
      values: timeline.points.map((point) => {
        if (point.sample === undefined) {
          return null;
        }
        const values = folded.flatMap((name) => {
          const value = point.sample?.series[`${prefix}${name}`];
          return value === undefined ? [] : [value];
        });
        return values.length === 0 ? null : Math.max(...values);
      }),
    });
  }
  return lines.filter(hasValue);
}

/** Member names with a value in the window, the newest sample's order first, then the older ones. */
function memberNames(timeline: Timeline, prefix: string): string[] {
  const names: string[] = [];
  for (const point of [...timeline.points].reverse()) {
    for (const key of Object.keys(point.sample?.series ?? {})) {
      if (key.startsWith(prefix)) {
        const name = key.slice(prefix.length);
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

/** The value of a stat panel's series in the newest sample. Undefined when that sample lacks it. */
export function latestSeriesValue(
  samples: readonly MonitorSample[],
  spec: SeriesSpec,
): number | undefined {
  return samples.at(-1)?.series[spec.id];
}

/** The stat tile values for one sample. Missing sections give undefined, not zero. */
export function headlineOf(sample: MonitorSample | undefined): MonitorHeadline {
  if (sample === undefined) {
    return {
      uptimeSeconds: undefined,
      currentConnections: undefined,
      cacheFillPercent: undefined,
      opsPerSecond: undefined,
      oplogWindowSeconds: undefined,
    };
  }
  const wiredTiger = sample.wiredTiger;
  const cacheFill =
    wiredTiger !== undefined && wiredTiger.cacheMaxMb > 0
      ? (wiredTiger.cacheUsedMb / wiredTiger.cacheMaxMb) * 100
      : undefined;
  const counters = sample.opcounters;
  const opsPerSecond =
    counters.insert +
    counters.query +
    counters.update +
    counters.delete +
    counters.getmore +
    counters.command;
  return {
    uptimeSeconds: sample.uptimeSeconds,
    currentConnections: sample.connections.current,
    cacheFillPercent: cacheFill,
    opsPerSecond,
    oplogWindowSeconds: sample.replication?.oplogWindowSeconds,
  };
}
