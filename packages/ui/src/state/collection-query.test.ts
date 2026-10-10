import { describe, expect, it } from 'vitest';
import { collectionQueryStatement } from './collection-query';

describe('collectionQueryStatement', () => {
  it('uses the property form for a plain name', () => {
    expect(collectionQueryStatement('orders')).toBe('db.orders.find({})');
    expect(collectionQueryStatement('_events2')).toBe('db._events2.find({})');
    expect(collectionQueryStatement('$cmd')).toBe('db.$cmd.find({})');
  });

  it('uses getCollection for a name with a dot, a dash, a space or a leading digit', () => {
    expect(collectionQueryStatement('order.lines')).toBe(
      'db.getCollection("order.lines").find({})',
    );
    expect(collectionQueryStatement('daily-totals')).toBe(
      'db.getCollection("daily-totals").find({})',
    );
    expect(collectionQueryStatement('my orders')).toBe('db.getCollection("my orders").find({})');
    expect(collectionQueryStatement('2024')).toBe('db.getCollection("2024").find({})');
  });

  it('escapes quotes and backslashes in the name', () => {
    expect(collectionQueryStatement('a"b\\c')).toBe('db.getCollection("a\\"b\\\\c").find({})');
  });
});
