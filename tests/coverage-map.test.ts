import { describe, expect, it } from 'vitest';
import { coverageMap } from '../e2e/coverage-map';
import { rpcContract } from '../packages/core/src/rpc/contract';

const contractMethods = Object.entries(rpcContract).flatMap(([namespace, calls]) =>
  Object.keys(calls).map((name) => `${namespace}.${name}`),
);

describe('coverage map', () => {
  it('has an entry for every contract method', () => {
    const missing = contractMethods.filter((method) => !(method in coverageMap));
    expect(missing).toEqual([]);
  });

  it('has no entry that is not in the contract', () => {
    const stale = Object.keys(coverageMap).filter((method) => !contractMethods.includes(method));
    expect(stale).toEqual([]);
  });

  it('gives every entry a non-empty journey or reason', () => {
    for (const [method, coverage] of Object.entries(coverageMap)) {
      const text = 'journey' in coverage ? coverage.journey : coverage.excluded;
      expect(text.trim(), method).not.toBe('');
    }
  });
});
