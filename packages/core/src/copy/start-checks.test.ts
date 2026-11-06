import { describe, expect, it } from 'vitest';
import type { CopyFinding } from './assess';
import { newestFittingTools, unresolvedCopyFindings } from './start-checks';

function finding(code: CopyFinding['code'], severity: CopyFinding['severity']): CopyFinding {
  return { code, severity, confirmable: false, message: `${code} ${severity}` };
}

describe('newestFittingTools', () => {
  it('picks the newest installed version that fits both servers', () => {
    // 8.0 needs 100.10.0, so 100.8.0 does not fit the pair.
    expect(newestFittingTools(['100.8.0', '100.12.0', '100.10.1'], ['8.0.4', '7.0.12'])).toBe(
      '100.12.0',
    );
  });

  it('ignores an installed version that is too old for one server', () => {
    expect(newestFittingTools(['100.9.0'], ['8.0.4'])).toBeUndefined();
  });

  it('returns undefined when nothing is installed', () => {
    expect(newestFittingTools([], ['8.0.4'])).toBeUndefined();
  });
});

describe('unresolvedCopyFindings', () => {
  it('keeps every block, even when acknowledged', () => {
    const block = finding('copy-overlap', 'block');
    expect(unresolvedCopyFindings([block], ['copy-overlap'])).toEqual([block]);
  });

  it('keeps a strong finding until its code is acknowledged', () => {
    const strong = finding('encrypted-collections', 'strong');
    expect(unresolvedCopyFindings([strong], [])).toEqual([strong]);
    expect(unresolvedCopyFindings([strong], ['encrypted-collections'])).toEqual([]);
  });

  it('ignores warnings and info', () => {
    const findings = [
      finding('copy-timeseries-rename', 'warning'),
      finding('copy-skipped-namespaces', 'info'),
    ];
    expect(unresolvedCopyFindings(findings, [])).toEqual([]);
  });
});
