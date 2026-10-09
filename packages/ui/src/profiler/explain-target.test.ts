import { describe, expect, it } from 'vitest';
import type { ProfileEntry } from '@mongo-gui/core';
import { explainTarget } from './profiler-model';

function entryOf(overrides: Partial<ProfileEntry>): ProfileEntry {
  return {
    id: 'entry-1',
    ts: '2026-10-05T08:15:04.000Z',
    ns: 'shop.orders',
    op: 'command',
    millis: 1,
    raw: {},
    ...overrides,
  };
}

describe('explainTarget', () => {
  it('explains a find as it is', () => {
    const command = { find: 'orders', filter: { status: 'paid' } };
    expect(explainTarget(entryOf({ op: 'query' }), command)).toEqual({ command });
  });

  it('wraps an update statement with its collection from the namespace', () => {
    const statement = { q: { status: 'paid' }, u: { $set: { x: 1 } }, multi: true };
    expect(explainTarget(entryOf({ op: 'update', ns: 'shop.orders' }), statement)).toEqual({
      command: statement,
      profileOp: 'update',
      collection: 'orders',
    });
  });

  it('wraps a remove statement with its collection from the namespace', () => {
    const statement = { q: { status: 'cancelled' }, limit: 0 };
    expect(explainTarget(entryOf({ op: 'remove', ns: 'shop.orders' }), statement)).toEqual({
      command: statement,
      profileOp: 'remove',
      collection: 'orders',
    });
  });

  it('keeps a dotted collection name whole', () => {
    expect(explainTarget(entryOf({ op: 'remove', ns: 'shop.order.items' }), { q: {} })).toEqual({
      command: { q: {} },
      profileOp: 'remove',
      collection: 'order.items',
    });
  });

  it('cannot explain an update whose namespace names no collection', () => {
    expect(explainTarget(entryOf({ op: 'update', ns: 'shop' }), { q: {} })).toBeUndefined();
  });

  it('explains a getMore as the find that opened its cursor', () => {
    const command = {
      getMore: 123456789,
      collection: 'orders',
      originatingCommand: { find: 'orders', filter: { status: 'paid' } },
    };
    expect(explainTarget(entryOf({ op: 'getmore' }), command)).toEqual({
      command: { find: 'orders', filter: { status: 'paid' } },
    });
  });

  it('cannot explain a getMore without its originating command', () => {
    expect(
      explainTarget(entryOf({ op: 'getmore' }), { getMore: 1, collection: 'orders' }),
    ).toBeUndefined();
  });
});
