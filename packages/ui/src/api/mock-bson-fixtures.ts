/**
 * Nested sample documents that hold every BSON type the views label. The mock stores them in
 * canonical EJSON, the form the runtime sends, so the views can be developed without a server.
 */

const BASE_TIME_MS = Date.UTC(2026, 0, 15, 8, 30, 0);
const HOUR_MS = 3_600_000;
const STATUSES = ['paid', 'pending', 'shipped', 'refunded'] as const;

function objectIdHex(seed: number): string {
  return seed.toString(16).padStart(24, '0');
}

/** A 16-byte UUID, base64 encoded, as a subtype 4 binary. */
function uuidBinary(seed: number): Record<string, unknown> {
  const bytes = Array.from({ length: 16 }, (_, index) => (seed * 17 + index * 13) % 256);
  return { $binary: { base64: btoa(String.fromCharCode(...bytes)), subType: '04' } };
}

/**
 * Documents of one collection. Each has a `_id`, a few top-level scalars with every number type,
 * an embedded customer with an address, and an array of order lines with nested values.
 */
export function bsonSampleDocuments(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const seed = index + 1;
    const status = STATUSES[index % STATUSES.length] ?? 'paid';
    const createdAt = new Date(BASE_TIME_MS + index * HOUR_MS).toISOString();
    return {
      _id: { $oid: objectIdHex(seed) },
      status,
      reference: `ORD-${String(seed).padStart(5, '0')}`,
      quantity: { $numberInt: String((index % 9) + 1) },
      total: { $numberLong: String(9_007_199_254_740_000 + seed) },
      ratio: { $numberDouble: String(((index % 10) + 0.5) / 10) },
      price: { $numberDecimal: `${(seed * 3.25).toFixed(2)}` },
      express: index % 2 === 0,
      discountCode: index % 4 === 0 ? null : 'SPRING',
      createdAt: { $date: createdAt },
      correlation: uuidBinary(seed),
      sequence: { $timestamp: { t: 1_768_465_800 + index, i: index % 5 } },
      pattern: { $regularExpression: { pattern: '^ORD-', options: 'i' } },
      tags: ['web', index % 3 === 0 ? 'gift' : 'standard'],
      customer: {
        name: `Customer ${seed}`,
        email: `customer${seed}@example.com`,
        address: {
          city: index % 2 === 0 ? 'Ljubljana' : 'Maribor',
          geo: { lat: { $numberDouble: '46.05' }, lng: { $numberDouble: '14.51' } },
        },
      },
      lines: [
        { sku: 'A-100', qty: { $numberInt: '2' }, unit: { $numberDecimal: '9.99' } },
        {
          sku: 'B-240',
          qty: { $numberInt: String((index % 3) + 1) },
          unit: { $numberDecimal: '24.50' },
        },
      ],
      bounds: { low: { $minKey: 1 }, high: { $maxKey: 1 } },
      note: { $undefined: true },
    };
  });
}
