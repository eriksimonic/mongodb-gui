import { describe, expect, it } from 'vitest';
import { cellText, progressLine, statusLine } from './transfer-model';
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

describe('progressLine', () => {
  const MB = 1024 * 1024;

  it('counts bytes for a GridFS job', () => {
    const progress = {
      ...emptyProgress(),
      processed: 5 * MB,
      bytesRead: 5 * MB,
      bytesTotal: 5 * MB,
    };
    expect(progressLine('gridfs-download', progress)).toBe('5.0 MB of 5.0 MB');
    expect(progressLine('gridfs-upload', progress)).toBe('5.0 MB of 5.0 MB');
  });

  it('counts records for an import or an export', () => {
    const progress = { ...emptyProgress(), processed: 1200, bytesRead: 5 * MB, bytesTotal: 5 * MB };
    expect(progressLine('import', progress)).toBe('1,200 processed');
    expect(progressLine('export', progress)).toBe('1,200 processed');
  });

  it('falls back to the processed bytes when the total is not known', () => {
    expect(progressLine('gridfs-upload', { ...emptyProgress(), processed: 2048 })).toBe(
      '2.0 KB processed',
    );
  });
});
