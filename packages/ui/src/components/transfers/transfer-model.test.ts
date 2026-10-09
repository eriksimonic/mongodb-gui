import { describe, expect, it } from 'vitest';
import { cellText, statusLine } from './transfer-model';
import { emptyProgress } from '../../state/transfer-state';

describe('cellText', () => {
  it('shows strings, nulls and missing values plainly', () => {
    expect(cellText('ord-1001')).toBe('ord-1001');
    expect(cellText(null)).toBe('null');
    expect(cellText(undefined)).toBe('');
  });

  it('unwraps canonical EJSON numbers and object ids to their plain text', () => {
    expect(cellText({ $numberDouble: '19.9' })).toBe('19.9');
    expect(cellText({ $numberLong: '42' })).toBe('42');
    expect(cellText({ $oid: '65b0c0ffee00000000000001' })).toBe('65b0c0ffee00000000000001');
  });

  it('shows a canonical EJSON date as an ISO string', () => {
    expect(cellText({ $date: { $numberLong: '1772356500000' } })).toBe('2026-03-01T09:15:00.000Z');
    expect(cellText({ $date: '2026-03-01T09:15:00Z' })).toBe('2026-03-01T09:15:00Z');
  });

  it('shows other objects and arrays as JSON', () => {
    expect(cellText({ city: 'Ljubljana' })).toBe('{"city":"Ljubljana"}');
    expect(cellText([1, 2])).toBe('[1,2]');
  });
});

describe('statusLine', () => {
  it('names the state of a transfer in one word', () => {
    expect(statusLine(emptyProgress())).toBe('Running');
    expect(statusLine({ ...emptyProgress(), done: true })).toBe('Done');
    expect(
      statusLine({ ...emptyProgress(), done: true, error: { code: 'CANCELLED', message: 'x' } }),
    ).toBe('Cancelled');
    expect(
      statusLine({ ...emptyProgress(), done: true, error: { code: 'VALIDATION', message: 'x' } }),
    ).toBe('Failed');
  });
});
