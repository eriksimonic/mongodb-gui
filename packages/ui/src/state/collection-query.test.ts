import { describe, expect, it } from 'vitest';
import { collectionQueryStatement } from './collection-query';

describe('collectionQueryStatement', () => {
  it('uses the property form for a plain name', () => {
    expect(collectionQueryStatement('orders')).toBe('db.orders.find({})');
    expect(collectionQueryStatement('events_2024')).toBe('db.events_2024.find({})');
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

  it('uses getCollection for a name that mongosh does not resolve as a property', () => {
    expect(collectionQueryStatement('_events')).toBe('db.getCollection("_events").find({})');
    expect(collectionQueryStatement('price$')).toBe('db.getCollection("price$").find({})');
  });

  it('uses getCollection for a name that matches a member of db', () => {
    expect(collectionQueryStatement('stats')).toBe('db.getCollection("stats").find({})');
    expect(collectionQueryStatement('version')).toBe('db.getCollection("version").find({})');
    expect(collectionQueryStatement('constructor')).toBe(
      'db.getCollection("constructor").find({})',
    );
  });

  it('escapes quotes and backslashes in the name', () => {
    expect(collectionQueryStatement('a"b\\c')).toBe('db.getCollection("a\\"b\\\\c").find({})');
  });
});
