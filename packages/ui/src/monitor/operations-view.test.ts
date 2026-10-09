import type { RunningOperation } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { commandExcerpt, filterOperations, killBlockReason } from './operations-view';

function operation(opid: string | number, ns: string): RunningOperation {
  return { opid, active: true, op: 'query', ns };
}

describe('filterOperations', () => {
  const operations = [operation(1, 'shop.orders'), operation(2, 'shop.events')];

  it('keeps every operation for a blank search', () => {
    expect(filterOperations(operations, '  ')).toHaveLength(2);
  });

  it('matches the namespace ignoring case', () => {
    expect(filterOperations(operations, 'EVENTS').map((item) => item.opid)).toEqual([2]);
  });
});

describe('commandExcerpt', () => {
  it('writes the command as one line of JSON', () => {
    expect(commandExcerpt({ find: 'orders', limit: 5 })).toBe('{"find":"orders","limit":5}');
  });

  it('cuts long commands and marks the cut', () => {
    const excerpt = commandExcerpt({ text: 'x'.repeat(500) }, 20);
    expect(excerpt).toHaveLength(23);
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('says so when there is no command', () => {
    expect(commandExcerpt(undefined)).toBe('No command recorded');
  });
});

describe('killBlockReason', () => {
  it('refuses idle placeholders and system threads, and allows real operations', () => {
    expect(killBlockReason(operation('conn:9', ''))).toBe(
      'Idle connections have no operation to kill.',
    );
    const system: RunningOperation = {
      opid: 12,
      active: false,
      op: 'none',
      ns: '',
      desc: 'Checkpointer',
    };
    expect(killBlockReason(system)).toBe('System threads cannot be killed from here.');
    expect(killBlockReason(operation(1041, 'shop.orders'))).toBeUndefined();
  });
});
