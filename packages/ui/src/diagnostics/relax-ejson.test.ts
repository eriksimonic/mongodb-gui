import { describe, expect, it } from 'vitest';
import { relaxEjson } from './relax-ejson';

describe('relaxEjson', () => {
  it('shows integers and longs as plain numbers', () => {
    expect(
      relaxEjson({ current: { $numberInt: '12' }, bytes: { $numberLong: '4096000000' } }),
    ).toEqual({
      current: 12,
      bytes: 4096000000,
    });
  });

  it('shows a date as ISO text', () => {
    expect(relaxEjson({ localTime: { $date: { $numberLong: '1767225600000' } } })).toEqual({
      localTime: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps the other wrappers and walks arrays', () => {
    expect(relaxEjson({ id: { $oid: 'abc' }, list: [{ $numberDouble: '1.5' }] })).toEqual({
      id: { $oid: 'abc' },
      list: [1.5],
    });
  });

  it('does not change its input', () => {
    const input = { n: { $numberInt: '1' } };
    relaxEjson(input);
    expect(input).toEqual({ n: { $numberInt: '1' } });
  });
});
