import { describe, expect, it } from 'vitest';
import { sameServer } from './server-identity';

describe('sameServer', () => {
  it('matches the same hosts in another order and case', () => {
    expect(
      sameServer(
        { hosts: ['B.example:27017', 'a.example:27017'], setName: 'rs0' },
        { hosts: ['a.example:27017', 'b.example:27017'], setName: 'rs0' },
      ),
    ).toBe(true);
  });

  it('differs when the replica set name differs', () => {
    expect(
      sameServer(
        { hosts: ['a.example:27017'], setName: 'rs0' },
        { hosts: ['a.example:27017'], setName: 'rs1' },
      ),
    ).toBe(false);
  });

  it('differs when one side has another host', () => {
    expect(
      sameServer({ hosts: ['a.example:27017'] }, { hosts: ['a.example:27017', 'b:27017'] }),
    ).toBe(false);
  });

  it('treats a missing set name as the same as no set name', () => {
    expect(sameServer({ hosts: ['a:27017'], setName: undefined }, { hosts: ['a:27017'] })).toBe(
      true,
    );
  });
});
