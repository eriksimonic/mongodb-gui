import { describe, expect, it } from 'vitest';
import { checkCoverage } from '../e2e/coverage-check';
import type { Coverage } from '../e2e/coverage-map';

const map: Readonly<Record<string, Coverage>> = {
  'vault.status': { journey: 'connect.spec.ts' },
  'connections.list': { journey: 'connect.spec.ts' },
  'vault.unlock': { excluded: 'vault master password' },
};

describe('checkCoverage', () => {
  it('passes when every journey method is called and nothing is wrong', () => {
    const lines = [
      '{"method":"vault.status","outcome":"ok"}',
      '',
      '   ',
      '{"method":"connections.list","outcome":"VALIDATION"}',
    ];
    expect(checkCoverage(map, lines)).toEqual([]);
  });

  it('reports a journey method that was never called', () => {
    const lines = ['{"method":"connections.list","outcome":"ok"}'];
    expect(checkCoverage(map, lines)).toEqual([
      'vault.status is mapped to connect.spec.ts but was never called',
    ]);
  });

  it('reports INTERNAL outcomes once per method with a count', () => {
    const lines = [
      '{"method":"vault.status","outcome":"ok"}',
      '{"method":"connections.list","outcome":"INTERNAL"}',
      '{"method":"connections.list","outcome":"INTERNAL"}',
    ];
    expect(checkCoverage(map, lines)).toEqual(['connections.list returned INTERNAL 2 times']);
  });

  it('reports a traced method that is not in the map', () => {
    const lines = [
      '{"method":"vault.status","outcome":"ok"}',
      '{"method":"connections.list","outcome":"ok"}',
      '{"method":"nope.call","outcome":"ok"}',
    ];
    expect(checkCoverage(map, lines)).toEqual(['nope.call is not in the coverage map']);
  });

  it('reports lines that are not valid trace lines', () => {
    const lines = [
      '{"method":"vault.status","outcome":"ok"}',
      '{"method":"connections.list","outcome":"ok"}',
      'not json',
      '{"method":1,"outcome":"ok"}',
    ];
    expect(checkCoverage(map, lines)).toEqual([
      'invalid trace line: not json',
      'invalid trace line: {"method":1,"outcome":"ok"}',
    ]);
  });
});
