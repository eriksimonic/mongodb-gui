import { describe, expect, it } from 'vitest';
import { rpcContract } from './contract';

const namespaces = Object.entries(rpcContract);

describe('rpcContract', () => {
  it('declares the namespaces required by P1-1', () => {
    expect(Object.keys(rpcContract).sort()).toEqual(
      [
        'app',
        'collections',
        'connections',
        'databases',
        'docker',
        'favourites',
        'history',
        'monitor',
        'settings',
        'transfer',
        'updates',
        'vault',
      ].sort(),
    );
  });

  it('gives every call an input and an output zod schema', () => {
    for (const [namespace, calls] of namespaces) {
      for (const [name, call] of Object.entries(calls)) {
        const label = `${namespace}.${name}`;
        expect(typeof call.input.safeParse, label).toBe('function');
        expect(typeof call.output.safeParse, label).toBe('function');
      }
    }
  });

  it('validates vault.reset against the literal DELETE confirmation', () => {
    const { input } = rpcContract.vault.reset;
    expect(input.safeParse({ confirmation: 'DELETE' }).success).toBe(true);
    expect(input.safeParse({ confirmation: 'delete' }).success).toBe(false);
  });

  it('rejects a vault password shorter than 10 characters on initialise', () => {
    const { input } = rpcContract.vault.initialise;
    expect(input.safeParse({ password: 'short' }).success).toBe(false);
    expect(input.safeParse({ password: 'long enough password' }).success).toBe(true);
  });

  it('rejects a connection id that is not a uuid', () => {
    expect(rpcContract.connections.connect.input.safeParse({ id: 'abc' }).success).toBe(false);
  });

  it('accepts a connection list response with redacted uris only', () => {
    const summary = {
      id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      name: 'Local',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      uriRedacted: 'mongodb://app:***@localhost/',
    };
    expect(rpcContract.connections.list.output.safeParse([summary]).success).toBe(true);
  });
});
