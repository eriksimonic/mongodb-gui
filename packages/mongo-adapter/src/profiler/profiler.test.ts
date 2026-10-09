import type { Document, MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { ProfileEntry } from '@mongo-gui/core';
import { listProfileEntries, tailProfileEntries } from './profiler';

// A fake collection that honours the ts lower bound, the sort direction and the limit. These
// tests cover paging behaviour that needs many rows in one millisecond, which an integration
// test cannot produce reliably.

interface FakeDoc {
  readonly ts: Date;
  readonly [key: string]: unknown;
}

interface FakeCursor {
  sort(spec: Document): FakeCursor;
  limit(count: number): FakeCursor;
  maxTimeMS(ms: number): FakeCursor;
  toArray(): Promise<FakeDoc[]>;
  [Symbol.asyncIterator](): AsyncIterator<FakeDoc>;
}

const DB = 'shop';
const TS = Date.UTC(2026, 9, 5, 8, 15, 0);

function profileDoc(): FakeDoc {
  return {
    op: 'query',
    ns: 'shop.orders',
    command: { find: 'orders', filter: { status: 'paid' } },
    millis: 1,
    planSummary: 'COLLSCAN',
    ts: new Date(TS),
  };
}

function lowerBound(query: Document): number {
  const clauses: unknown[] = Array.isArray(query.$and) ? query.$and : [];
  for (const clause of clauses) {
    if (typeof clause === 'object' && clause !== null && 'ts' in clause) {
      const range: unknown = clause.ts;
      if (typeof range === 'object' && range !== null && '$gte' in range) {
        const bound: unknown = range.$gte;
        if (bound instanceof Date) {
          return bound.getTime();
        }
      }
    }
  }
  return 0;
}

function fakeClient(docs: FakeDoc[]): MongoClient {
  const collection = {
    find(query: Document): FakeCursor {
      const since = lowerBound(query);
      let direction = 1;
      let max = Number.POSITIVE_INFINITY;
      const rows = (): FakeDoc[] =>
        docs
          .filter((doc) => doc.ts.getTime() >= since)
          .sort((a, b) => direction * (a.ts.getTime() - b.ts.getTime()))
          .slice(0, max);
      const cursor: FakeCursor = {
        sort(spec: Document): FakeCursor {
          direction = spec.ts === -1 ? -1 : 1;
          return cursor;
        },
        limit(count: number): FakeCursor {
          max = count;
          return cursor;
        },
        maxTimeMS(): FakeCursor {
          return cursor;
        },
        toArray: async () => rows(),
        async *[Symbol.asyncIterator]() {
          for (const doc of rows()) {
            yield doc;
          }
        },
      };
      return cursor;
    },
  };
  return { db: () => ({ collection: () => collection }) } as unknown as MongoClient;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('tailProfileEntries with many rows in one millisecond', () => {
  it('delivers every row once even when the rows exceed the per-poll limit', async () => {
    const docs = Array.from({ length: 30 }, () => profileDoc());
    const received: ProfileEntry[] = [];
    const tail = tailProfileEntries(fakeClient(docs), DB, {
      since: new Date(TS - 1).toISOString(),
      pollMs: 50,
      filter: { limit: 5 },
    });
    tail.onEntries((batch) => received.push(...batch));
    try {
      await waitUntil(() => received.length === 30, 5000);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      tail.stop();
    }
    expect(received).toHaveLength(30);
    expect(new Set(received.map((entry) => entry.id)).size).toBe(30);
  });
});

describe('listProfileEntries with identical documents', () => {
  it('gives every returned entry a unique id', async () => {
    const docs = Array.from({ length: 30 }, () => profileDoc());
    const entries = await listProfileEntries(fakeClient(docs), DB, {});
    expect(entries).toHaveLength(30);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(30);
  });
});
