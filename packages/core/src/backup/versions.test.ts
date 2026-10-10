import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  firstToolsFor,
  majorMinor,
  parseVersion,
  TOOLS_SERVER_SUPPORT,
} from './versions';

describe('parseVersion', () => {
  it('reads three parts', () => {
    expect(parseVersion('8.0.17')).toEqual({ major: 8, minor: 0, patch: 17 });
  });

  it('defaults the patch to 0', () => {
    expect(parseVersion('9.0')).toEqual({ major: 9, minor: 0, patch: 0 });
  });

  it('ignores suffixes', () => {
    expect(parseVersion('8.2.0-rc1')).toEqual({ major: 8, minor: 2, patch: 0 });
    expect(parseVersion('7.0.4-ent')).toEqual({ major: 7, minor: 0, patch: 4 });
    expect(parseVersion('100.19.1-alpha')).toEqual({ major: 100, minor: 19, patch: 1 });
  });

  it('refuses text without a major.minor', () => {
    expect(parseVersion('')).toBeUndefined();
    expect(parseVersion('8')).toBeUndefined();
    expect(parseVersion('v8.0.1')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('compares numerically per part', () => {
    expect(compareVersions('100.9.0', '100.10.0')).toBeLessThan(0);
    expect(compareVersions('8.0.10', '8.0.9')).toBeGreaterThan(0);
    expect(compareVersions('9.0', '9.0.0')).toBe(0);
    expect(compareVersions('8.0.0-rc1', '8.0.0')).toBe(0);
  });

  it('sorts a version that does not parse first', () => {
    expect(compareVersions('x', '4.2.0')).toBeLessThan(0);
    expect(compareVersions('4.2.0', 'x')).toBeGreaterThan(0);
    expect(compareVersions('x', 'y')).toBe(0);
  });
});

describe('majorMinor', () => {
  it('drops the patch and suffix', () => {
    expect(majorMinor('8.0.17-ent')).toBe('8.0');
    expect(majorMinor('nope')).toBeUndefined();
  });
});

describe('firstToolsFor', () => {
  it.each(TOOLS_SERVER_SUPPORT.map((row) => [row.server, row.tools]))(
    'gives %s the tools %s',
    (server, tools) => {
      expect(firstToolsFor(`${server}.3`)).toEqual({ tools, beyondTable: false });
    },
  );

  it('uses the row below for a release between rows', () => {
    expect(firstToolsFor('7.3.0')).toEqual({ tools: '100.8.0', beyondTable: false });
  });

  it('uses the last row past the end and says so', () => {
    expect(firstToolsFor('9.1.0')).toEqual({ tools: '100.18.0', beyondTable: true });
    expect(firstToolsFor('10.0.0-rc0')).toEqual({ tools: '100.18.0', beyondTable: true });
  });

  it('gives nothing for a server older than the table or an unreadable version', () => {
    expect(firstToolsFor('4.2.24')).toBeUndefined();
    expect(firstToolsFor('unknown')).toBeUndefined();
  });
});
