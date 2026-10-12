const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Bytes in the largest unit that keeps the number under 1024, with one decimal from 10 on. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Milliseconds with a thousands separator, for example "9,410 ms". */
export function formatMs(ms: number): string {
  return `${Math.round(ms).toLocaleString('en-US')} ms`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** A timestamp as a local date and time, or the input when it does not parse. */
export function formatTimestamp(iso: string | undefined): string {
  if (iso === undefined) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** How long ago a timestamp was, such as "12 s ago" or "3 min ago". Falls back to the local time. */
export function formatRelative(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined) {
    return '';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} h ago`;
  }
  return formatTimestamp(iso);
}

/** A long identifier cut to its first characters, so a 64-character hash does not fill a column. */
export function shortId(value: string, keep = 12): string {
  return value.length <= keep + 1 ? value : `${value.slice(0, keep)}…`;
}

/** Seconds as "3 d 1 h", "3 h 38 min", "4 min 5 s" or "9 s": the two largest non-zero units. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const parts: [number, string][] = [
    [Math.floor(seconds / 86_400), 'd'],
    [Math.floor((seconds % 86_400) / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'min'],
    [seconds % 60, 's'],
  ];
  const shown = parts.filter(([amount]) => amount > 0).slice(0, 2);
  return shown.length === 0 ? '0 s' : shown.map(([amount, unit]) => `${amount} ${unit}`).join(' ');
}

/**
 * A readable form of a serverStatus number, chosen by its key: bytes for names that mention bytes,
 * a duration for uptime. Undefined when the key gives no unit.
 */
export function unitHint(key: string, value: number): string | undefined {
  const name = key.toLowerCase();
  if (name === 'uptime' || name === 'uptimeestimate') {
    return formatDuration(value);
  }
  if (name === 'uptimemillis') {
    return formatDuration(value / 1000);
  }
  if (name.includes('bytes') && value >= 1024) {
    return formatBytes(value);
  }
  return undefined;
}
