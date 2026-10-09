import { describe, expect, it } from 'vitest';
import {
  CHANGE_PAUSE_BUFFER_LIMIT,
  ChangeEventSchema,
  ChangeTargetSchema,
  ChangeWatchOptionsSchema,
  ChangeWatchStateSchema,
  MAX_CHANGE_BATCH_SIZE,
  MAX_CHANGE_EVENT_BYTES,
} from './types';

const event = {
  id: '1',
  operationType: 'insert',
  ns: { db: 'shop', coll: 'orders' },
  resumeTokenEjson: '{"_data":"8265"}',
  sizeBytes: 120,
  rawEjson: '{"operationType":"insert"}',
};

describe('ChangeTargetSchema', () => {
  it('accepts each target kind', () => {
    expect(
      ChangeTargetSchema.safeParse({ kind: 'collection', database: 'shop', collection: 'orders' })
        .success,
    ).toBe(true);
    expect(ChangeTargetSchema.safeParse({ kind: 'database', database: 'shop' }).success).toBe(true);
    expect(ChangeTargetSchema.safeParse({ kind: 'deployment' }).success).toBe(true);
  });

  it('rejects an empty name and a collection target without a collection', () => {
    expect(ChangeTargetSchema.safeParse({ kind: 'database', database: '' }).success).toBe(false);
    expect(ChangeTargetSchema.safeParse({ kind: 'collection', database: 'shop' }).success).toBe(
      false,
    );
  });
});

describe('ChangeWatchOptionsSchema', () => {
  it('accepts an empty options object', () => {
    expect(ChangeWatchOptionsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts the full-document modes the driver supports', () => {
    for (const fullDocument of ['default', 'updateLookup', 'whenAvailable', 'required']) {
      expect(ChangeWatchOptionsSchema.safeParse({ fullDocument }).success).toBe(true);
    }
    for (const fullDocumentBeforeChange of ['off', 'whenAvailable', 'required']) {
      expect(ChangeWatchOptionsSchema.safeParse({ fullDocumentBeforeChange }).success).toBe(true);
    }
    expect(ChangeWatchOptionsSchema.safeParse({ fullDocument: 'always' }).success).toBe(false);
  });

  it('bounds the batch size and the await time', () => {
    expect(ChangeWatchOptionsSchema.safeParse({ batchSize: MAX_CHANGE_BATCH_SIZE }).success).toBe(
      true,
    );
    expect(
      ChangeWatchOptionsSchema.safeParse({ batchSize: MAX_CHANGE_BATCH_SIZE + 1 }).success,
    ).toBe(false);
    expect(ChangeWatchOptionsSchema.safeParse({ batchSize: 0 }).success).toBe(false);
    expect(ChangeWatchOptionsSchema.safeParse({ maxAwaitTimeMs: 0 }).success).toBe(false);
  });

  it('refuses a resume token together with an operation time', () => {
    const result = ChangeWatchOptionsSchema.safeParse({
      resumeAfterEjson: '{"_data":"8265"}',
      startAtOperationTimeEjson: '{"$timestamp":{"t":1,"i":1}}',
    });
    expect(result.success).toBe(false);
  });
});

describe('ChangeEventSchema', () => {
  it('accepts a minimal event', () => {
    expect(ChangeEventSchema.safeParse(event).success).toBe(true);
  });

  it('accepts a truncated event', () => {
    const truncated = { ...event, truncated: true, sizeBytes: MAX_CHANGE_EVENT_BYTES + 1 };
    expect(ChangeEventSchema.safeParse(truncated).success).toBe(true);
  });

  it('rejects a negative size and a missing resume token', () => {
    expect(ChangeEventSchema.safeParse({ ...event, sizeBytes: -1 }).success).toBe(false);
    expect(ChangeEventSchema.safeParse({ ...event, resumeTokenEjson: '' }).success).toBe(false);
  });
});

describe('ChangeWatchStateSchema', () => {
  const state = {
    phase: 'opening',
    eventsSeen: 0,
    eventsDropped: 0,
    openedAt: '2026-10-09T08:00:00.000Z',
  };

  it('accepts each phase', () => {
    for (const phase of ['opening', 'live', 'paused', 'closed', 'error']) {
      expect(ChangeWatchStateSchema.safeParse({ ...state, phase }).success).toBe(true);
    }
  });

  it('accepts an error with an AppError', () => {
    const errored = {
      ...state,
      phase: 'error',
      error: { code: 'COMMAND_FAILED', message: 'The server rejected the command' },
    };
    expect(ChangeWatchStateSchema.safeParse(errored).success).toBe(true);
  });

  it('rejects an unknown phase', () => {
    expect(ChangeWatchStateSchema.safeParse({ ...state, phase: 'running' }).success).toBe(false);
  });
});

describe('change limits', () => {
  it('keeps the pause buffer and the event size limit at the documented values', () => {
    expect(CHANGE_PAUSE_BUFFER_LIMIT).toBe(1000);
    expect(MAX_CHANGE_EVENT_BYTES).toBe(1024 * 1024);
  });
});
