import type { LogLine } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { componentsOf, DEFAULT_LOG_FILTER, filterLogLines, severityRank } from './log-filter';

function line(
  severity: string | undefined,
  component: string | undefined,
  message: string,
  attributes?: unknown,
): LogLine {
  return {
    message,
    raw: message,
    ...(severity === undefined ? {} : { severity }),
    ...(component === undefined ? {} : { component }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

const LINES: LogLine[] = [
  line('I', 'NETWORK', 'Connection accepted', { remote: '10.0.0.1:5000' }),
  line('D1', 'COMMAND', 'About to run the command'),
  line('W', 'QUERY', 'Many plans considered'),
  line('E', 'COMMAND', 'Command failed', { errmsg: 'duplicate key' }),
  { message: 'a line in an unknown format', raw: 'a line in an unknown format' },
];

describe('filterLogLines', () => {
  it('lists every line newest first, keeping the position in the reply', () => {
    const shown = filterLogLines(LINES, DEFAULT_LOG_FILTER);
    expect(shown.map((item) => item.index)).toEqual([4, 3, 2, 1, 0]);
  });

  it('keeps the lines at or above the minimum severity', () => {
    const shown = filterLogLines(LINES, { ...DEFAULT_LOG_FILTER, minSeverity: 'W' });
    expect(shown.map((item) => item.line.message)).toEqual([
      'Command failed',
      'Many plans considered',
    ]);
  });

  it('drops lines without a severity once a level is chosen', () => {
    const shown = filterLogLines(LINES, { ...DEFAULT_LOG_FILTER, minSeverity: 'D' });
    expect(shown.some((item) => item.line.severity === undefined)).toBe(false);
    expect(shown).toHaveLength(4);
  });

  it('keeps the lines of one component', () => {
    const shown = filterLogLines(LINES, { ...DEFAULT_LOG_FILTER, component: 'COMMAND' });
    expect(shown.map((item) => item.index)).toEqual([3, 1]);
  });

  it('matches text in the message, the component and the attributes, ignoring case', () => {
    expect(
      filterLogLines(LINES, { ...DEFAULT_LOG_FILTER, text: 'DUPLICATE' }).map((item) => item.index),
    ).toEqual([3]);
    expect(
      filterLogLines(LINES, { ...DEFAULT_LOG_FILTER, text: ' network ' }).map((item) => item.index),
    ).toEqual([0]);
    expect(
      filterLogLines(LINES, { ...DEFAULT_LOG_FILTER, text: '10.0.0.1' }).map((item) => item.index),
    ).toEqual([0]);
  });

  it('combines the level, component and text filters', () => {
    const shown = filterLogLines(LINES, { minSeverity: 'D', component: 'COMMAND', text: 'run' });
    expect(shown.map((item) => item.index)).toEqual([1]);
  });
});

describe('severityRank', () => {
  it('ranks the debug levels together and unknown severities at zero', () => {
    expect(severityRank('D5')).toBe(severityRank('D1'));
    expect(severityRank('F')).toBeGreaterThan(severityRank('E'));
    expect(severityRank(undefined)).toBe(0);
  });
});

describe('componentsOf', () => {
  it('lists the distinct components sorted', () => {
    expect(componentsOf(LINES)).toEqual(['COMMAND', 'NETWORK', 'QUERY']);
  });
});
