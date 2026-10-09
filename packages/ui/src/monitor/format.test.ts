import { describe, expect, it } from 'vitest';
import {
  formatAxisValue,
  formatBytes,
  formatDuration,
  formatInterval,
  formatValue,
  unitCaption,
} from './format';

describe('formatBytes', () => {
  it('uses binary steps with one decimal below ten', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(20 * 1024 ** 2)).toBe('20 MB');
  });
});

describe('formatDuration', () => {
  it('shows the two largest units', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(125)).toBe('2 min 5 s');
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3 h 12 min');
    expect(formatDuration(2 * 86_400 + 4 * 3600)).toBe('2 d 4 h');
  });
});

describe('formatValue', () => {
  it('writes each catalogue unit with its label', () => {
    expect(formatValue(12.34, 'per-second')).toBe('12.3/s');
    expect(formatValue(7, 'count')).toBe('7');
    expect(formatValue(2048, 'bytes-per-second')).toBe('2.0 KB/s');
    expect(formatValue(5 * 1024 ** 2, 'bytes')).toBe('5.0 MB');
    expect(formatValue(37, 'ms')).toBe('37 ms');
    expect(formatValue(40.25, 'percent')).toBe('40.3%');
    expect(formatValue(0.4, 'seconds')).toBe('0.4 s');
    expect(formatValue(300, 'seconds')).toBe('5 min 0 s');
  });
});

describe('unitCaption', () => {
  it('names each unit for the card caption', () => {
    expect(unitCaption('per-second')).toBe('Per second');
    expect(unitCaption('bytes-per-second')).toBe('Bytes per second');
    expect(unitCaption('ms')).toBe('Milliseconds');
  });
});

describe('formatAxisValue', () => {
  it('shortens big counts for ticks and writes byte ticks with binary prefixes', () => {
    expect(formatAxisValue(12_900, 'count')).toBe('12.9K');
    expect(formatAxisValue(3 * 1024 ** 2, 'bytes-per-second')).toBe('3.0 MB');
    expect(formatAxisValue(80, 'percent')).toBe('80%');
  });
});

describe('formatInterval', () => {
  it('writes the selector labels', () => {
    expect(formatInterval(1000)).toBe('1 s');
    expect(formatInterval(10_000)).toBe('10 s');
  });
});
