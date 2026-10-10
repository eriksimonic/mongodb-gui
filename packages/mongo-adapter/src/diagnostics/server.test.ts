import { describe, expect, it } from 'vitest';
import { serverStatusDocument } from './server';

describe('serverStatusDocument', () => {
  it('returns the canonical EJSON document as a plain object', () => {
    const document = serverStatusDocument({
      at: '2026-01-01T00:00:00.000Z',
      stripped: ['tcmalloc'],
      rawJson: '{}',
      canonicalJson: JSON.stringify({
        localTime: { $date: { $numberLong: '1767225600000' } },
        uptimeMillis: { $numberLong: '90000' },
        connections: { current: { $numberInt: '12' } },
      }),
    });

    expect(document).toEqual({
      localTime: { $date: { $numberLong: '1767225600000' } },
      uptimeMillis: { $numberLong: '90000' },
      connections: { current: { $numberInt: '12' } },
    });
  });

  it('returns an empty document when the canonical text is not an object', () => {
    expect(
      serverStatusDocument({ at: '', stripped: [], rawJson: '[1]', canonicalJson: '[1]' }),
    ).toEqual({});
  });
});
