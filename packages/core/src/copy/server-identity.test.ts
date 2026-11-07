import { describe, expect, it } from 'vitest';
import { sameServer, type ServerIdentity } from './server-identity';

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly a: ServerIdentity;
  readonly b: ServerIdentity;
  readonly same: boolean;
}> = [
  {
    name: 'two standalone servers with distinct hosts differ',
    a: { hosts: ['ecd690c7a175:27017'] },
    b: { hosts: ['e1585e35625e:27017'] },
    same: false,
  },
  {
    name: 'one standalone server through two profiles is the same',
    a: { hosts: ['ecd690c7a175:27017'] },
    b: { hosts: ['ecd690c7a175:27017'] },
    same: true,
  },
  {
    name: 'one host name on two ports is two servers',
    a: { hosts: ['box:27017'] },
    b: { hosts: ['box:27018'] },
    same: false,
  },
  {
    name: 'one host name and port is the same server',
    a: { hosts: ['box:27017'] },
    b: { hosts: ['box:27017'] },
    same: true,
  },
  {
    name: 'a standalone host in another case is the same',
    a: { hosts: ['ECD690C7A175:27017'] },
    b: { hosts: ['ecd690c7a175:27017'] },
    same: true,
  },
  {
    name: 'two servers with no hosts differ',
    a: { hosts: [] },
    b: { hosts: [] },
    same: false,
  },
  {
    name: 'a host list that is a subset of the other differs',
    a: { hosts: ['a.example:27017'] },
    b: { hosts: ['a.example:27017', 'b:27017'] },
    same: false,
  },
  {
    name: 'a server with no hosts differs from one with hosts',
    a: { hosts: [] },
    b: { hosts: ['ecd690c7a175:27017'] },
    same: false,
  },
  {
    name: 'a server with hosts differs from one with no hosts',
    a: { hosts: ['ecd690c7a175:27017'] },
    b: { hosts: [] },
    same: false,
  },
  {
    name: 'a server with no hosts differs even when the set names match',
    a: { hosts: [], setName: 'rs0' },
    b: { hosts: [], setName: 'rs0' },
    same: false,
  },
  {
    name: 'a replica set with the same name and members is the same',
    a: { hosts: ['a.example:27017', 'b.example:27017'], setName: 'rs0' },
    b: { hosts: ['a.example:27017', 'b.example:27017'], setName: 'rs0' },
    same: true,
  },
  {
    name: 'the same members in another order are the same',
    a: { hosts: ['B.example:27017', 'a.example:27017'], setName: 'rs0' },
    b: { hosts: ['a.example:27017', 'b.example:27017'], setName: 'rs0' },
    same: true,
  },
  {
    name: 'the same hosts with different set names differ',
    a: { hosts: ['a.example:27017'], setName: 'rs0' },
    b: { hosts: ['a.example:27017'], setName: 'rs1' },
    same: false,
  },
  {
    name: 'a set name on one side only differs',
    a: { hosts: ['a.example:27017'], setName: 'rs0' },
    b: { hosts: ['a.example:27017'] },
    same: false,
  },
  {
    name: 'a missing set name is the same as an undefined set name',
    a: { hosts: ['a.example:27017'], setName: undefined },
    b: { hosts: ['a.example:27017'] },
    same: true,
  },
];

describe('sameServer', () => {
  it.each(CASES)('$name', ({ a, b, same }) => {
    expect(sameServer(a, b)).toBe(same);
    expect(sameServer(b, a)).toBe(same);
  });
});
