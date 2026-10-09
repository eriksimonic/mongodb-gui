import { describe, expect, it } from 'vitest';
import { findHostListProblem } from './host-list';

describe('findHostListProblem', () => {
  it('accepts a single host, a replica set list, and an IPv6 host', () => {
    expect(findHostListProblem('mongodb://127.0.0.1:27017')).toBeUndefined();
    expect(findHostListProblem('mongodb://a:1,b:2,c/?replicaSet=rs')).toBeUndefined();
    expect(findHostListProblem('mongodb://u:p@[::1]:27017/db')).toBeUndefined();
    expect(findHostListProblem('mongodb+srv://cluster.example.net/')).toBeUndefined();
  });

  it('rejects an empty host after a comma', () => {
    const problem = findHostListProblem('mongodb://admin:pw@127.0.0.1:37017,/?replicaSet=x');
    expect(problem).toBe('The connection string lists an empty host');
    expect(problem).not.toContain('pw');
  });

  it('rejects an empty entry in the middle of the list', () => {
    expect(findHostListProblem('mongodb://a:1,,b:2/')).toBe(
      'The connection string lists an empty host',
    );
  });

  it('rejects a port that is not a number in range', () => {
    expect(findHostListProblem('mongodb://a:port/')).toBe(
      'The connection string lists an invalid port',
    );
    expect(findHostListProblem('mongodb://a:0/')).toBe(
      'The connection string lists an invalid port',
    );
    expect(findHostListProblem('mongodb://a:70000/')).toBe(
      'The connection string lists an invalid port',
    );
  });

  it('rejects a string that is not a MongoDB URI', () => {
    expect(findHostListProblem('http://a:1/')).toBe(
      'The connection string must start with mongodb:// or mongodb+srv://',
    );
  });
});
