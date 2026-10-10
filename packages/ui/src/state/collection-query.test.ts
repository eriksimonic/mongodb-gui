import { describe, expect, it } from 'vitest';
import { collectionQueryStatement, collectionSelectStatement } from './collection-query';

describe('collectionQueryStatement', () => {
  it('uses the property form for a plain name', () => {
    expect(collectionQueryStatement('orders')).toBe('db.orders.find({})');
    expect(collectionQueryStatement('events_2024')).toBe('db.events_2024.find({})');
  });

  it('uses getCollection for a name with a dot, a dash, a space or a leading digit', () => {
    expect(collectionQueryStatement('order.lines')).toBe(
      "db.getCollection('order.lines').find({})",
    );
    expect(collectionQueryStatement('daily-totals')).toBe(
      "db.getCollection('daily-totals').find({})",
    );
    expect(collectionQueryStatement('my orders')).toBe("db.getCollection('my orders').find({})");
    expect(collectionQueryStatement('2024')).toBe("db.getCollection('2024').find({})");
  });

  it('uses getCollection for a name that mongosh does not resolve as a property', () => {
    expect(collectionQueryStatement('_events')).toBe("db.getCollection('_events').find({})");
    expect(collectionQueryStatement('price$')).toBe("db.getCollection('price$').find({})");
  });

  it('uses getCollection for a name that matches a member of db', () => {
    expect(collectionQueryStatement('stats')).toBe("db.getCollection('stats').find({})");
    expect(collectionQueryStatement('version')).toBe("db.getCollection('version').find({})");
    expect(collectionQueryStatement('constructor')).toBe(
      "db.getCollection('constructor').find({})",
    );
  });

  it('escapes quotes and backslashes in the name', () => {
    expect(collectionQueryStatement("it's")).toBe("db.getCollection('it\\'s').find({})");
    expect(collectionQueryStatement('a"b\\c')).toBe("db.getCollection('a\"b\\\\c').find({})");
  });
});

describe('collectionSelectStatement', () => {
  it('uses the bare name for a plain identifier', () => {
    expect(collectionSelectStatement('orders')).toBe('SELECT * FROM orders;');
    expect(collectionSelectStatement('events_2024')).toBe('SELECT * FROM events_2024;');
    expect(collectionSelectStatement('_events')).toBe('SELECT * FROM _events;');
  });

  it('brackets a name with a dot, a dash, a space or a leading digit', () => {
    expect(collectionSelectStatement('order.lines')).toBe('SELECT * FROM [order.lines];');
    expect(collectionSelectStatement('daily-totals')).toBe('SELECT * FROM [daily-totals];');
    expect(collectionSelectStatement('my orders')).toBe('SELECT * FROM [my orders];');
    expect(collectionSelectStatement('2024')).toBe('SELECT * FROM [2024];');
  });

  it('brackets a name with a character outside ASCII or a dollar sign', () => {
    expect(collectionSelectStatement('naročila')).toBe('SELECT * FROM [naročila];');
    expect(collectionSelectStatement('price$')).toBe('SELECT * FROM [price$];');
  });

  it('brackets a SQL keyword in any case', () => {
    expect(collectionSelectStatement('user')).toBe('SELECT * FROM [user];');
    expect(collectionSelectStatement('User')).toBe('SELECT * FROM [User];');
    expect(collectionSelectStatement('TABLE')).toBe('SELECT * FROM [TABLE];');
    expect(collectionSelectStatement('order')).toBe('SELECT * FROM [order];');
    expect(collectionSelectStatement('group')).toBe('SELECT * FROM [group];');
  });

  it('does not bracket a name that only contains a keyword', () => {
    expect(collectionSelectStatement('users')).toBe('SELECT * FROM users;');
    expect(collectionSelectStatement('order_lines')).toBe('SELECT * FROM order_lines;');
    expect(collectionSelectStatement('top10')).toBe('SELECT * FROM top10;');
  });

  it('doubles a closing bracket in the name', () => {
    expect(collectionSelectStatement('a]b')).toBe('SELECT * FROM [a]]b];');
  });

  it('brackets every keyword of the list', () => {
    const words = [
      'SELECT',
      'FROM',
      'WHERE',
      'ORDER',
      'GROUP',
      'BY',
      'JOIN',
      'ON',
      'AS',
      'SET',
      'VALUES',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TOP',
      'DISTINCT',
      'HAVING',
      'LEFT',
      'INNER',
      'INTO',
      'TABLE',
      'USER',
    ];
    for (const word of words) {
      expect(collectionSelectStatement(word.toLowerCase())).toBe(
        `SELECT * FROM [${word.toLowerCase()}];`,
      );
    }
  });

  it('brackets an empty name', () => {
    expect(collectionSelectStatement('')).toBe('SELECT * FROM [];');
  });
});
