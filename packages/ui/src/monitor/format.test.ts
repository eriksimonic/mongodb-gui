import { describe, expect, it } from 'vitest';
import {
  formatAxisValue,
  formatBytes,
  formatDuration,
  formatInterval,
  formatValue,
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
  it('writes each unit with its label', () => {
    expect(formatValue(12.34, 'perSecond')).toBe('12.3 ops/s');
    expect(formatValue(7, 'count')).toBe('7');
    expect(formatValue(2048, 'bytesPerSecond')).toBe('2.0 KB/s');
    expect(formatValue(512, 'megabytes')).toBe('512 MB');
    expect(formatValue(0.4, 'seconds')).toBe('0.4 s');
    expect(formatValue(300, 'seconds')).toBe('5 min 0 s');
  });
});

describe('formatAxisValue', () => {
  it('shortens big counts and byte rates for ticks', () => {
    expect(formatAxisValue(12_900, 'count')).toBe('12.9K');
    expect(formatAxisValue(3 * 1024 ** 2, 'bytesPerSecond')).toBe('3.0 MB');
  });
});

describe('formatInterval', () => {
  it('writes the selector labels', () => {
    expect(formatInterval(1000)).toBe('1 s');
    expect(formatInterval(10_000)).toBe('10 s');
  });
});
