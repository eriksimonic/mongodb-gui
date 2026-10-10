import { describe, expect, it } from 'vitest';
import { rpcContract } from './contract';

const namespaces = Object.entries(rpcContract);
const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';

describe('rpcContract', () => {
  it('declares the namespaces required by P1-1, P2-2, P2-5 layout, the P3-1 explain runner, the P4-B management calls and the P6-2 profiler', () => {
    expect(Object.keys(rpcContract).sort()).toEqual(
      [
        'app',
        'collections',
        'connections',
        'databases',
        'docker',
        'explain',
        'favourites',
        'history',
        'layout',
        'management',
        'monitor',
        'profiler',
        'replication',
        'schema',
        'settings',
        'transfer',
        'shell',
        'updates',
        'vault',
      ].sort(),
    );
  });

  it('applies a replica set plan by id and version, and defaults the step-down to 60 seconds', () => {
    const { replication } = rpcContract;
    const connectionId = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
    const planId = '0d6f3b2a-9c1e-4f7a-8b5d-2e4c6a1f9b30';
    expect(
      replication.applyReconfig.input.safeParse({ connectionId, planId, expectedVersion: 4 })
        .success,
    ).toBe(true);
    expect(
      replication.applyReconfig.input.safeParse({
        connectionId,
        planId: 'plan',
        expectedVersion: 4,
      }).success,
    ).toBe(false);
    expect(
      replication.applyReconfig.input.safeParse({ connectionId, planId, expectedVersion: 0 })
        .success,
    ).toBe(false);
    expect(replication.stepDown.input.parse({ connectionId })).toEqual({
      connectionId,
      stepDownSeconds: 60,
    });
    expect(
      replication.stepDown.input.safeParse({ connectionId, stepDownSeconds: 3601 }).success,
    ).toBe(false);
    expect(
      replication.initiate.input.safeParse({ connectionId, setName: 'rs0', members: [] }).success,
    ).toBe(false);
  });

  it('declares schema.analyse with a sample size up to 5000 and a strategy', () => {
    const { analyse } = rpcContract.schema;
    const ok = analyse.input.safeParse({
      connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      database: 'shop',
      collection: 'orders',
      size: 5000,
      strategy: 'first',
    });
    expect(ok.success).toBe(true);
    const tooLarge = analyse.input.safeParse({
      connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      database: 'shop',
      collection: 'orders',
      size: 5001,
      strategy: 'first',
    });
    expect(tooLarge.success).toBe(false);
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

  describe('management', () => {
    const { management } = rpcContract;

    it('requires a connection id on every call', () => {
      for (const [name, call] of Object.entries(management)) {
        const withoutConnection = call.input.safeParse({
          database: 'shop',
          collection: 'orders',
          name: 'orders',
          newName: 'orders2',
          sampleSize: 10,
          limit: 5,
          idEjson: '{}',
          idsEjson: [],
          keys: { a: 1 },
          options: {},
          rules: { validatorEjson: '{}', validationLevel: 'strict', validationAction: 'error' },
          documentEjson: '{}',
          filterEjson: '{}',
          expectedCount: 0,
        });
        expect(withoutConnection.success, name).toBe(false);
      }
    });

    it('accepts a create collection input with capped options and an EJSON validator', () => {
      const result = management.createCollection.input.safeParse({
        connectionId: CONNECTION_ID,
        database: 'shop',
        name: 'orders',
        capped: { sizeBytes: 1_048_576 },
        validatorEjson: '{"status": {"$in": ["paid"]}}',
      });
      expect(result.success).toBe(true);
    });

    it('refuses a collection that is both capped and timeseries', () => {
      const result = management.createCollection.input.safeParse({
        connectionId: CONNECTION_ID,
        database: 'shop',
        name: 'orders',
        capped: { sizeBytes: 1024 },
        timeseries: { timeField: 'ts' },
      });
      expect(result.success).toBe(false);
    });

    it('refuses to drop the _id_ index through the contract', () => {
      const result = management.dropIndex.input.safeParse({
        connectionId: CONNECTION_ID,
        database: 'shop',
        collection: 'orders',
        name: '_id_',
      });
      expect(result.success).toBe(false);
    });

    it('bounds the sample sizes of validation checks and document sampling', () => {
      const base = { connectionId: CONNECTION_ID, database: 'shop', collection: 'orders' };
      expect(
        management.checkValidation.input.safeParse({ ...base, sampleSize: 10_001 }).success,
      ).toBe(false);
      expect(
        management.checkValidation.input.safeParse({ ...base, sampleSize: 1000 }).success,
      ).toBe(true);
      expect(management.sampleDocuments.input.safeParse({ ...base, limit: 201 }).success).toBe(
        false,
      );
    });

    it('returns an id string from insert and EJSON strings from reads', () => {
      const oid = '{"$oid":"64b7f0f0e4b0a1b2c3d4e5f6"}';
      expect(management.insertDocument.output.safeParse(oid).success).toBe(true);
      expect(management.sampleDocuments.output.safeParse(['{"a":1}']).success).toBe(true);
      expect(management.findDocumentById.output.safeParse(null).success).toBe(true);
    });
  });
});
