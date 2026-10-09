import type { SeriesUnit } from '@mongo-gui/core';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const BYTE_STEP = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const exactFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const compactFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Up to one decimal, thousands separated. Used for values that must read exactly. */
export function formatExact(value: number): string {
  return exactFormat.format(value);
}

/** Short form for big counts in stat tiles, such as 12.9K. */
export function formatCompact(value: number): string {
  return compactFormat.format(value);
}

/** Binary units with one decimal below 10 and none above. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let index = 0;
  while (value >= BYTE_STEP && index < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    index += 1;
  }
  const digits = index > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${BYTE_UNITS[index]}`;
}

/** Days and hours, hours and minutes, minutes and seconds, or plain seconds. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  if (days > 0) {
    return `${days} d ${hours} h`;
  }
  if (hours > 0) {
    return `${hours} h ${minutes} min`;
  }
  if (minutes > 0) {
    return `${minutes} min ${seconds % SECONDS_PER_MINUTE} s`;
  }
  return `${seconds} s`;
}

/** A value with its unit, for tooltips, legend readouts and stat tiles. */
export function formatValue(value: number, unit: SeriesUnit): string {
  switch (unit) {
    case 'count':
      return formatExact(value);
    case 'per-second':
      return `${formatExact(value)}/s`;
    case 'bytes':
      return formatBytes(value);
    case 'bytes-per-second':
      return `${formatBytes(value)}/s`;
    case 'ms':
      return `${formatExact(value)} ms`;
    case 'percent':
      return `${formatExact(value)}%`;
    case 'seconds':
      return value < SECONDS_PER_MINUTE ? `${formatExact(value)} s` : formatDuration(value);
  }
}

/** The unit's name, written under a chart title. */
export function unitCaption(unit: SeriesUnit): string {
  switch (unit) {
    case 'count':
      return 'Count';
    case 'per-second':
      return 'Per second';
    case 'bytes':
      return 'Bytes';
    case 'bytes-per-second':
      return 'Bytes per second';
    case 'ms':
      return 'Milliseconds';
    case 'percent':
      return 'Percent';
    case 'seconds':
      return 'Seconds';
  }
}

/** Axis tick label. Shorter than the tooltip form, with the unit left to the card caption. */
export function formatAxisValue(value: number, unit: SeriesUnit): string {
  switch (unit) {
    case 'bytes':
    case 'bytes-per-second':
      return formatBytes(value);
    case 'percent':
      return `${formatCompact(value)}%`;
    default:
      return formatCompact(value);
  }
}

/** Clock time in local time, hours, minutes and seconds. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (part: number): string => part.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Interval as the selector shows it: 1 s, 2 s, 5 s, 10 s. */
export function formatInterval(intervalMs: number): string {
  return `${intervalMs / 1000} s`;
}
