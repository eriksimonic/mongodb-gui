import type {
  AppError,
  BackupJobKind,
  BackupNamespaceProgress,
  BackupProgress,
  BackupResult,
  ToolLogLine,
} from '@mongo-gui/core';

export type BackupPhase = BackupProgress['phase'];

export interface ProgressTotals {
  // Estimated before a dump, from the sidecar before a restore.
  documents?: number;
  namespaces?: number;
}

export interface SnapshotEnd {
  done: boolean;
  cancelled: boolean;
  error?: AppError;
  result?: BackupResult;
}

export interface ProgressTracker {
  /** Folds one redacted stderr line in. */
  line(parsed: ToolLogLine, text: string): void;
  /** Adds bytes written, read or hashed in the current phase. */
  bytes(count: number): void;
  /**
   * Starts a phase. A byte total resets the byte counter and drives the fraction until the next
   * phase.
   */
  phase(phase: BackupPhase, totalBytes?: number): void;
  /** Names the database a several-database dump is on. Clears the active list. */
  database(name: string, index: number, count: number): void;
  /** The progress so far. Lines and warnings are only the ones since the previous snapshot. */
  snapshot(end: SnapshotEnd): BackupProgress;
  /** Documents per namespace from `done dumping` and `finished restoring` lines. */
  finished(): ReadonlyMap<string, number>;
  /** Namespaces in `restoring` lines, in order. A dry run plan comes from these. */
  restoring(): readonly string[];
  /** Every WARNING line so far. */
  warnings(): readonly string[];
  documents(): number;
  failed(): number;
}

const MAX_ACTIVE = 32;
const MAX_LINES = 100;
const MAX_WARNINGS = 20;
// The dump fraction stays below 1 until the tool exits: the estimates can be low.
const RUNNING_CAP = 0.99;

interface Bar {
  done: number;
  total?: number;
  unit: 'documents' | 'bytes';
}

/**
 * Turns tool lines and byte counts into BackupProgress snapshots. The dump fraction is documents
 * over the estimated total. A restore uses bytes over the archive size when a byte total is set,
 * else documents over the sidecar total, else the byte bars per namespace, else none.
 */
export function createProgressTracker(
  kind: BackupJobKind,
  totals: ProgressTotals,
  now: () => number,
): ProgressTracker {
  const startedAt = now();
  let phase: BackupPhase = 'preparing';
  let bytes = 0;
  let totalBytes: number | undefined;
  const active = new Map<string, Bar>();
  // Byte bars of namespaces that finished, so the bar fraction does not fall back.
  const finishedBars = new Map<string, Bar>();
  const finished = new Map<string, number>();
  const restoring: string[] = [];
  let finishedDocuments = 0;
  let failedDocuments = 0;
  let summary: { restored: number; failed: number } | undefined;
  let database: { name: string; index: number; count: number } | undefined;
  let lines: string[] = [];
  let newWarnings: string[] = [];
  const allWarnings: string[] = [];

  const push = (list: string[], text: string, cap: number): void => {
    list.push(text);
    if (list.length > cap) list.shift();
  };

  const runningDocuments = (): number => {
    let sum = 0;
    for (const bar of active.values()) {
      if (bar.unit === 'documents') sum += bar.done;
    }
    return sum;
  };

  const documents = (): number => summary?.restored ?? finishedDocuments + runningDocuments();

  const barFraction = (): number | undefined => {
    let done = 0;
    let total = 0;
    for (const bar of [...finishedBars.values(), ...active.values()]) {
      if (bar.unit !== 'bytes' || bar.total === undefined) continue;
      done += bar.done;
      total += bar.total;
    }
    return total > 0 ? done / total : undefined;
  };

  const fraction = (end: SnapshotEnd): number | undefined => {
    if (end.done) {
      return end.error === undefined && !end.cancelled ? 1 : undefined;
    }
    if (totalBytes !== undefined && totalBytes > 0) {
      return Math.min(1, bytes / totalBytes);
    }
    if (phase !== 'running') return undefined;
    const totalDocuments = totals.documents;
    if (totalDocuments !== undefined && totalDocuments > 0) {
      return Math.min(kind === 'dump' ? RUNNING_CAP : 1, documents() / totalDocuments);
    }
    return kind === 'restore' ? barFraction() : undefined;
  };

  const finish = (namespace: string, count: number): void => {
    const bar = active.get(namespace);
    if (bar?.unit === 'bytes' && bar.total !== undefined) {
      finishedBars.set(namespace, { ...bar, done: bar.total });
    }
    active.delete(namespace);
    finished.set(namespace, (finished.get(namespace) ?? 0) + count);
    finishedDocuments += count;
  };

  return {
    line(parsed, text) {
      push(lines, text, MAX_LINES);
      switch (parsed.kind) {
        case 'bar':
          active.set(parsed.namespace, {
            done: parsed.done,
            total: parsed.total,
            unit: parsed.unit,
          });
          break;
        case 'bar-open':
          active.set(parsed.namespace, { done: parsed.done, unit: parsed.unit });
          break;
        case 'writing':
          if (!active.has(parsed.namespace)) {
            active.set(parsed.namespace, { done: 0, unit: 'documents' });
          }
          break;
        case 'restoring':
          restoring.push(parsed.namespace);
          if (!active.has(parsed.namespace)) {
            active.set(parsed.namespace, { done: 0, unit: 'documents' });
          }
          break;
        case 'dumped':
          finish(parsed.namespace, parsed.documents);
          break;
        case 'restored':
          finish(parsed.namespace, parsed.documents);
          failedDocuments += parsed.failures;
          break;
        case 'summary':
          summary = { restored: parsed.restored, failed: parsed.failed };
          break;
        case 'warning':
          push(newWarnings, parsed.text, MAX_WARNINGS);
          allWarnings.push(parsed.text);
          break;
        case 'failed':
        case 'other':
          break;
      }
    },
    bytes(count) {
      bytes += count;
    },
    phase(next, total) {
      phase = next;
      totalBytes = total;
      if (total !== undefined) bytes = 0;
    },
    database(name, index, count) {
      database = { name, index, count };
      active.clear();
    },
    snapshot(end) {
      const shown: BackupNamespaceProgress[] = [];
      for (const [namespace, bar] of active) {
        if (shown.length >= MAX_ACTIVE) break;
        shown.push({
          namespace,
          documents: bar.done,
          ...(bar.total === undefined ? {} : { total: bar.total }),
        });
      }
      const share = fraction(end);
      const progress: BackupProgress = {
        phase: end.done ? 'finished' : phase,
        documents: documents(),
        ...(totals.documents === undefined ? {} : { totalDocuments: totals.documents }),
        bytes,
        ...(totalBytes === undefined ? {} : { totalBytes }),
        ...(share === undefined ? {} : { fraction: share }),
        active: shown,
        finishedNamespaces: finished.size,
        ...(totals.namespaces === undefined ? {} : { totalNamespaces: totals.namespaces }),
        ...(database === undefined
          ? {}
          : {
              currentDatabase: database.name,
              databaseIndex: database.index,
              databaseCount: database.count,
            }),
        failedDocuments: summary?.failed ?? failedDocuments,
        lines,
        warnings: newWarnings,
        elapsedMs: Math.max(0, now() - startedAt),
        done: end.done,
        cancelled: end.cancelled,
        ...(end.error === undefined ? {} : { error: end.error }),
        ...(end.result === undefined ? {} : { result: end.result }),
      };
      lines = [];
      newWarnings = [];
      return progress;
    },
    finished: () => finished,
    restoring: () => restoring,
    warnings: () => allWarnings,
    documents,
    failed: () => summary?.failed ?? failedDocuments,
  };
}
