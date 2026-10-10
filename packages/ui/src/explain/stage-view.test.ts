import { describe, expect, it } from 'vitest';
import { describeStage, type PlanStage, type PlanWarning } from '@mongo-gui/core';
import {
  examinedRatio,
  findTextMatches,
  formatBytes,
  formatCount,
  formatDuration,
  nextMatchIndex,
  previousMatchIndex,
  shardErrorMessage,
  sortWarnings,
  stageMetricItems,
} from './stage-view';

function stage(name: string, extra: Partial<PlanStage> = {}): PlanStage {
  return { name, children: [], raw: undefined, ...extra };
}

describe('formatters', () => {
  it('groups counts with thousands separators', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('shows milliseconds under a second and seconds from there', () => {
    expect(formatDuration(12)).toBe('12 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
  });

  it('shows bytes in the largest binary unit under 1024', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MiB');
  });
});

describe('stageMetricItems', () => {
  it('shows only the metrics the catalogue marks meaningful for the stage', () => {
    const collscan = stage('COLLSCAN', { docsExamined: 2000, keysExamined: 5, nReturned: 3 });
    const labels = stageMetricItems(collscan, describeStage('COLLSCAN')).map((item) => item.label);
    expect(labels).toEqual(['Docs', 'Returned']);
  });

  it('shows keys for an index scan and not documents', () => {
    const ixscan = stage('IXSCAN', { keysExamined: 20, docsExamined: 20, nReturned: 20 });
    const labels = stageMetricItems(ixscan, describeStage('IXSCAN')).map((item) => item.label);
    expect(labels).toEqual(['Keys', 'Returned']);
  });

  it('highlights spill counters only when they are non-zero', () => {
    const sort = stage('sort', {
      memUsageBytes: 2048,
      memLimitBytes: 4096,
      usedDisk: true,
      spills: 0,
      spilledBytes: 0,
    });
    const items = stageMetricItems(sort, describeStage('sort'));
    const highlighted = items.filter((item) => item.highlight).map((item) => item.label);
    expect(highlighted).toEqual(['Memory', 'Used disk']);
    expect(items.find((item) => item.label === 'Spills')).toMatchObject({
      text: '0',
      highlight: false,
    });
  });

  it('formats a sort spill with separators and sizes', () => {
    const sort = stage('sort', { spills: 4, spilledBytes: 1048576, nReturned: 1500 });
    const items = stageMetricItems(sort, describeStage('sort'));
    expect(items.map((item) => `${item.label} ${item.text}`)).toEqual([
      'Returned 1,500',
      'Spills 4',
      'Spilled 1 MiB',
    ]);
  });
});

describe('examinedRatio', () => {
  it('gives the documents examined per document returned on a scan', () => {
    const fetch = stage('FETCH', { docsExamined: 1000, nReturned: 10 });
    expect(examinedRatio(fetch, describeStage('FETCH'))).toMatchObject({ ratio: 100, high: true });
  });

  it('is not high at or below the threshold', () => {
    const fetch = stage('FETCH', { docsExamined: 20, nReturned: 10 });
    expect(examinedRatio(fetch, describeStage('FETCH'))).toMatchObject({ ratio: 2, high: false });
  });

  it('is not shown on a stage outside scans and fetches', () => {
    const sort = stage('SORT', { docsExamined: 20, nReturned: 10 });
    expect(examinedRatio(sort, describeStage('SORT'))).toBeUndefined();
  });
});

describe('shardErrorMessage', () => {
  it('reads the message of a server error object', () => {
    expect(shardErrorMessage({ error: { errmsg: 'boom' } })).toBe('boom');
  });

  it('falls back to a plain message when the shard reports none', () => {
    expect(shardErrorMessage({})).toBe('The shard failed.');
  });
});

describe('sortWarnings', () => {
  it('puts the most severe warnings first and keeps the core order within a severity', () => {
    const warning = (code: string, severity: PlanWarning['severity']): PlanWarning => ({
      code: code as PlanWarning['code'],
      severity,
      message: code,
    });
    const sorted = sortWarnings([
      warning('A', 'info'),
      warning('B', 'critical'),
      warning('C', 'warning'),
      warning('D', 'critical'),
    ]);
    expect(sorted.map((item) => item.message)).toEqual(['B', 'D', 'C', 'A']);
  });
});

describe('findTextMatches', () => {
  it('finds every case-insensitive occurrence in reading order', () => {
    const text = 'Stage\nstage and STAGE';
    expect(findTextMatches(text, 'stage')).toEqual([
      { line: 1, column: 1, length: 5 },
      { line: 2, column: 1, length: 5 },
      { line: 2, column: 11, length: 5 },
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(findTextMatches('abc', '')).toEqual([]);
  });
});

describe('match stepping', () => {
  it('wraps forward from the last match to the first', () => {
    expect(nextMatchIndex(2, 3)).toBe(0);
    expect(nextMatchIndex(0, 3)).toBe(1);
  });

  it('wraps backward from the first match to the last', () => {
    expect(previousMatchIndex(0, 3)).toBe(2);
    expect(previousMatchIndex(2, 3)).toBe(1);
  });

  it('has no current match when there are none', () => {
    expect(nextMatchIndex(0, 0)).toBe(-1);
    expect(previousMatchIndex(0, 0)).toBe(-1);
  });
});
