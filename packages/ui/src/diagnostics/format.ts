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
