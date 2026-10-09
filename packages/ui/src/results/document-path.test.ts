import { describe, expect, it } from 'vitest';
import { withValueAtPath, withoutPath } from './document-path';
import { formatCount, type JsonObject } from './result-model';

const DOCUMENT: JsonObject = {
  _id: { $oid: '65f0c0ffee0000000000abcd' },
  status: 'paid',
  customer: { name: 'Ada', address: { city: 'Ljubljana' } },
  lines: [{ sku: 'A' }, { sku: 'B' }],
};

describe('withValueAtPath', () => {
  it('sets a top-level field', () => {
    expect(withValueAtPath(DOCUMENT, 'status', 'open').status).toBe('open');
  });

  it('sets a nested field and leaves the original document alone', () => {
    const next = withValueAtPath(DOCUMENT, 'customer.address.city', 'Koper');
    expect(next.customer).toEqual({ name: 'Ada', address: { city: 'Koper' } });
    expect(DOCUMENT.customer).toEqual({ name: 'Ada', address: { city: 'Ljubljana' } });
  });

  it('sets an array element by its index', () => {
    const next = withValueAtPath(DOCUMENT, 'lines.1.sku', 'C');
    expect(next.lines).toEqual([{ sku: 'A' }, { sku: 'C' }]);
  });

  it('creates a missing object along the path', () => {
    const next = withValueAtPath(DOCUMENT, 'shipping.courier', 'DHL');
    expect(next.shipping).toEqual({ courier: 'DHL' });
  });

  it('leaves the document as it was when a scalar is in the way', () => {
    expect(withValueAtPath(DOCUMENT, 'status.code', 1)).toEqual(DOCUMENT);
  });
});

describe('withoutPath', () => {
  it('removes a top-level field', () => {
    expect(withoutPath(DOCUMENT, 'status')).not.toHaveProperty('status');
  });

  it('removes a nested field', () => {
    expect(withoutPath(DOCUMENT, 'customer.address.city').customer).toEqual({
      name: 'Ada',
      address: {},
    });
  });

  it('sets an array element to null, as $unset does', () => {
    expect(withoutPath(DOCUMENT, 'lines.0').lines).toEqual([null, { sku: 'B' }]);
  });

  it('returns the document unchanged for a path that is not there', () => {
    expect(withoutPath(DOCUMENT, 'missing.field')).toEqual(DOCUMENT);
  });
});

describe('formatCount', () => {
  it('shows an open total while more documents may follow', () => {
    expect(formatCount(50, true)).toBe('1 to 50 of ?');
  });

  it('shows the exact total once the cursor is exhausted', () => {
    expect(formatCount(12, false)).toBe('1 to 12 of 12');
  });

  it('says so when there are no documents', () => {
    expect(formatCount(0, false)).toBe('No documents');
  });
});
