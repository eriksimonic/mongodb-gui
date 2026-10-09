import { describe, expect, it } from 'vitest';
import { rpcContract } from './contract';

const namespaces = Object.entries(rpcContract);

describe('rpcContract', () => {
  it('declares the namespaces required by P1-1 and the profiler namespace of P6-2', () => {
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
        'profiler',
        'settings',
        'updates',
        'vault',
      ].sort(),
    );
  });

  it('declares the profiler calls with the level, list, shapes, info and tail inputs', () => {
    const { profiler } = rpcContract;
    expect(Object.keys(profiler).sort()).toEqual(
      ['info', 'level', 'list', 'setLevel', 'shapes', 'tail'].sort(),
    );
    const database = { connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10', database: 'shop' };
    expect(profiler.level.input.safeParse(database).success).toBe(true);
    expect(
      profiler.setLevel.input.safeParse({ ...database, level: 1, slowMs: 50, sampleRate: 0.5 })
        .success,
    ).toBe(true);
    expect(profiler.setLevel.input.safeParse({ ...database, level: 3 }).success).toBe(false);
    expect(profiler.list.input.safeParse({ ...database, filter: {} }).success).toBe(true);
    expect(profiler.list.input.safeParse({ ...database }).success).toBe(false);
    expect(profiler.shapes.input.safeParse({ ...database, filter: { limit: 0 } }).success).toBe(
      false,
    );
    expect(profiler.info.input.safeParse(database).success).toBe(true);
  });

  it('defaults the tail poll interval to 2000 ms and rejects polls under 50 ms', () => {
    const { input } = rpcContract.profiler.tail;
    const base = { connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10', database: 'shop' };
    const parsed = input.parse({ ...base, enabled: true });
    expect(parsed.pollMs).toBe(2000);
    expect(input.safeParse({ ...base, enabled: true, pollMs: 10 }).success).toBe(false);
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
