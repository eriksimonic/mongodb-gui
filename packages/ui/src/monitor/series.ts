import type { MonitorSample } from '@mongo-gui/core';
import type { MetricUnit } from './format';

export const MONITOR_RANGES = ['5m', '15m', '1h'] as const;
export type MonitorRange = (typeof MONITOR_RANGES)[number];

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
// A gap longer than this many intervals is an outage. The line breaks there instead of bridging it.
const GAP_FACTOR = 2.5;
// Replication lag gets one line per member, up to this many. Further members fold into "Other".
const MAX_LAG_LINES = 8;
const OTHER_LAG_LABEL = 'Other';

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

type OpCode = keyof MonitorSample['opcounters'];

const OP_CODES: readonly (readonly [OpCode, string])[] = [
  ['insert', 'Insert'],
  ['query', 'Query'],
  ['update', 'Update'],
  ['delete', 'Delete'],
  ['getmore', 'Get more'],
  ['command', 'Command'],
];

/** One line in a chart. `values` holds null where the server reported nothing or a gap starts. */
export interface SeriesLine {
  readonly key: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly values: readonly (number | null)[];
  /** A reference line is drawn dashed. It sets the scale but is not a measured series. */
  readonly reference?: boolean;
}

/** Every chart on the dashboard, built from one run of samples on a shared time axis. */
export interface MonitorSeries {
  /** Epoch seconds, oldest first. Gap breaks add a point with null values. */
  readonly times: readonly number[];
  readonly operations: readonly SeriesLine[];
  /** Plotted lines. Available connections are a readout, not a line, so the scale stays readable. */
  readonly connections: readonly SeriesLine[];
  readonly connectionsReadout: readonly SeriesLine[];
  readonly network: readonly SeriesLine[];
  readonly memory: readonly SeriesLine[];
  readonly queues: readonly SeriesLine[];
  readonly replicationLag: readonly SeriesLine[];
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

function pointsOf(samples: readonly MonitorSample[], intervalMs: number): Point[] {
  const points: Point[] = [];
  let previous: number | undefined;
  for (const sample of samples) {
    const time = Date.parse(sample.at) / MS_PER_SECOND;
    if (previous !== undefined && (time - previous) * MS_PER_SECOND > GAP_FACTOR * intervalMs) {
      points.push({ time: previous + intervalMs / MS_PER_SECOND, sample: undefined });
    }
    points.push({ time, sample });
    previous = time;
  }
  return points;
}

/**
 * Turns samples into the lines of every chart. A gap longer than 2.5 intervals gets a break point,
 * so lines do not bridge an outage. Replication lag keeps up to eight lines and folds the rest into
 * "Other", which takes the largest lag among the folded members.
 */
export function seriesFromSamples(
  samples: readonly MonitorSample[],
  intervalMs: number = inferIntervalMs(samples),
): MonitorSeries {
  const points = pointsOf(samples, intervalMs);
  const line = (
    key: string,
    label: string,
    unit: MetricUnit,
    pick: (sample: MonitorSample) => number | undefined,
    reference = false,
  ): SeriesLine => ({
    key,
    label,
    unit,
    values: points.map((point) =>
      point.sample === undefined ? null : (pick(point.sample) ?? null),
    ),
    ...(reference ? { reference: true } : {}),
  });

  const hasCache = samples.some((sample) => sample.wiredTiger !== undefined);
  const hasLock = samples.some((sample) => sample.globalLock !== undefined);
  const hasActive = samples.some((sample) => sample.connections.active !== undefined);
  const latest = samples.at(-1);
  const lagLines = replicationLagLines(points, latest);

  return {
    times: points.map((point) => point.time),
    operations: OP_CODES.map(([code, label]) =>
      line(`op:${code}`, label, 'perSecond', (sample) => sample.opcounters[code]),
    ),
    connections: [
      line('connections:current', 'Current', 'count', (sample) => sample.connections.current),
      ...(hasActive
        ? [line('connections:active', 'Active', 'count', (sample) => sample.connections.active)]
        : []),
    ],
    connectionsReadout: [
      line('connections:available', 'Available', 'count', (sample) => sample.connections.available),
    ],
    network: [
      line('network:in', 'Bytes in', 'bytesPerSecond', (sample) => sample.network.bytesInPerSec),
      line('network:out', 'Bytes out', 'bytesPerSecond', (sample) => sample.network.bytesOutPerSec),
    ],
    memory: [
      line('memory:resident', 'Resident', 'megabytes', (sample) => sample.memory.residentMb),
      line('memory:virtual', 'Virtual', 'megabytes', (sample) => sample.memory.virtualMb),
      ...(hasCache
        ? [
            line(
              'cache:used',
              'Cache used',
              'megabytes',
              (sample) => sample.wiredTiger?.cacheUsedMb,
            ),
            line(
              'cache:max',
              'Cache max',
              'megabytes',
              (sample) => sample.wiredTiger?.cacheMaxMb,
              true,
            ),
          ]
        : []),
    ],
    queues: hasLock
      ? [
          line(
            'queue:readers',
            'Queued readers',
            'count',
            (sample) => sample.globalLock?.currentQueueReaders,
          ),
          line(
            'queue:writers',
            'Queued writers',
            'count',
            (sample) => sample.globalLock?.currentQueueWriters,
          ),
        ]
      : [],
    replicationLag: lagLines.map((item) => ({
      key: item.key,
      label: item.label,
      unit: 'seconds' as const,
      values: points.map((point) => (point.sample === undefined ? null : item.pick(point.sample))),
    })),
  };
}

interface LagLine {
  readonly key: string;
  readonly label: string;
  readonly pick: (sample: MonitorSample) => number | null;
}

function lagOf(sample: MonitorSample, name: string): number | undefined {
  return sample.replication?.members.find((member) => member.name === name)?.lagSeconds;
}

/** One line per member up to the cap. Past the cap, the first seven stay and the rest fold into "Other". */
function replicationLagLines(
  points: readonly Point[],
  latest: MonitorSample | undefined,
): LagLine[] {
  const names = (latest?.replication?.members ?? []).map((member) => member.name);
  const folded = names.length > MAX_LAG_LINES ? names.slice(MAX_LAG_LINES - 1) : [];
  const shown = folded.length > 0 ? names.slice(0, MAX_LAG_LINES - 1) : names;
  const lines: LagLine[] = shown.map((name) => ({
    key: `lag:${name}`,
    label: name,
    pick: (sample) => lagOf(sample, name) ?? null,
  }));
  if (folded.length > 0) {
    lines.push({
      key: 'lag:other',
      label: OTHER_LAG_LABEL,
      pick: (sample) => {
        const values = folded.flatMap((name) => {
          const value = lagOf(sample, name);
          return value === undefined ? [] : [value];
        });
        return values.length === 0 ? null : Math.max(...values);
      },
    });
  }
  return lines.filter((item) =>
    points.some((point) => point.sample !== undefined && item.pick(point.sample) !== null),
  );
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
