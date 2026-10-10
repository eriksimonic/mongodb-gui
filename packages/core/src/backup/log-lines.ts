// Parses one stderr line from mongodump or mongorestore. Pure, so the job code stays small.
export type ToolLogLine =
  | {
      kind: 'bar';
      namespace: string;
      timeseries: boolean;
      // Document counts or bytes, see unit.
      done: number;
      total: number;
      unit: 'documents' | 'bytes';
      percent: number;
    }
  | {
      kind: 'bar-open';
      namespace: string;
      timeseries: boolean;
      done: number;
      unit: 'documents' | 'bytes';
    }
  | { kind: 'writing'; namespace: string; timeseries: boolean }
  | { kind: 'dumped'; namespace: string; timeseries: boolean; documents: number }
  | { kind: 'restoring'; namespace: string; timeseries: boolean }
  | {
      kind: 'restored';
      namespace: string;
      timeseries: boolean;
      documents: number;
      failures: number;
    }
  | { kind: 'summary'; restored: number; failed: number }
  | { kind: 'warning'; text: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'other'; text: string };

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\t/;
const BAR = /^\[[#.]{24}\]\s+(\S+)\s+(\S+)\/(\S+)\s+\(([\d.]+)%\)/;
const BAR_OPEN = /^\[[#.]{24}\]\s+(\S+)\s+(\S+)$/;
const WRITING = /^writing `([^`]+)` to/;
const DUMPED = /^done dumping `([^`]+)` \((\d+) documents?\)/;
const RESTORING = /^restoring `([^`]+)` from/;
// A dry run restores nothing. With -v it lists what it would restore in these lines instead.
const WOULD_RESTORE = /^found collection `([^`]+)` bson to restore to/;
const RESTORED = /^finished restoring `([^`]+)` \((\d+) documents?, (\d+) failures?\)/;
const SUMMARY =
  /^(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore\./;
const SIZE = /^(\d+(?:\.\d+)?)(B|KB|MB|GB|TB)$/;
const UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

// "86.6MB" becomes bytes, "141578" stays a count.
function amount(text: string): { value: number; unit: 'documents' | 'bytes' } | undefined {
  const size = SIZE.exec(text);
  if (size)
    return { value: Math.round(Number(size[1]) * (UNITS[size[2] ?? ''] ?? 1)), unit: 'bytes' };
  if (/^\d+$/.test(text)) return { value: Number(text), unit: 'documents' };
  return undefined;
}

// Time series data lives in db.system.buckets.x. Show it as db.x.
function namespaceOf(raw: string): { namespace: string; timeseries: boolean } {
  const dot = raw.indexOf('.');
  if (dot > 0 && raw.startsWith('system.buckets.', dot + 1)) {
    return {
      namespace: `${raw.slice(0, dot)}.${raw.slice(dot + 1 + 'system.buckets.'.length)}`,
      timeseries: true,
    };
  }
  return { namespace: raw, timeseries: false };
}

export function parseToolLine(line: string): ToolLogLine {
  const text = line.replace(/\r?\n$/, '').replace(TIMESTAMP, '');
  let m: RegExpExecArray | null;

  if ((m = BAR.exec(text))) {
    const done = amount(m[2] ?? '');
    const total = amount(m[3] ?? '');
    if (done && total) {
      return {
        kind: 'bar',
        ...namespaceOf(m[1] ?? ''),
        done: done.value,
        total: total.value,
        unit: done.unit,
        percent: Number(m[4]),
      };
    }
  } else if ((m = BAR_OPEN.exec(text))) {
    const done = amount(m[2] ?? '');
    if (done)
      return { kind: 'bar-open', ...namespaceOf(m[1] ?? ''), done: done.value, unit: done.unit };
  }
  if ((m = WRITING.exec(text))) return { kind: 'writing', ...namespaceOf(m[1] ?? '') };
  if ((m = DUMPED.exec(text))) {
    return { kind: 'dumped', ...namespaceOf(m[1] ?? ''), documents: Number(m[2]) };
  }
  if ((m = RESTORING.exec(text)) ?? (m = WOULD_RESTORE.exec(text)))
    return { kind: 'restoring', ...namespaceOf(m[1] ?? '') };
  if ((m = RESTORED.exec(text))) {
    return {
      kind: 'restored',
      ...namespaceOf(m[1] ?? ''),
      documents: Number(m[2]),
      failures: Number(m[3]),
    };
  }
  if ((m = SUMMARY.exec(text)))
    return { kind: 'summary', restored: Number(m[1]), failed: Number(m[2]) };
  if (text.startsWith('WARNING:')) return { kind: 'warning', text };
  if ((m = /^Failed: (.*)/.exec(text))) return { kind: 'failed', reason: m[1] ?? '' };
  return { kind: 'other', text };
}
