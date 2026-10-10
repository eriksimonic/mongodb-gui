import type { SchemaAnalyseInput, SchemaReport } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { createSchemaStore, type AnalyseCall } from './schema-store';

const TARGET = {
  connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  database: 'shop',
  collection: 'orders',
};

function report(sampled: number): SchemaReport {
  return {
    database: 'shop',
    collection: 'orders',
    sampled,
    total: 2000,
    fields: [{ path: 'status', types: ['String'], presence: 1 }],
    at: '2026-10-09T10:00:00.000Z',
  };
}

function clock(values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? 0;
}

describe('createSchemaStore', () => {
  it('starts with a random sample of 1000 and no report', () => {
    const store = createSchemaStore({ target: TARGET, analyse: vi.fn<AnalyseCall>() });
    expect(store.getState()).toMatchObject({
      sampleSize: 1000,
      strategy: 'random',
      report: undefined,
      loading: false,
      error: undefined,
    });
  });

  it('sends the target, size and strategy, then keeps the report and the elapsed time', async () => {
    const analyse = vi.fn<AnalyseCall>(() => Promise.resolve(report(500)));
    const store = createSchemaStore({ target: TARGET, analyse, now: clock([100, 142]) });
    store.getState().setSampleSize(500);
    store.getState().setStrategy('last');

    await store.getState().analyse();

    const expected: SchemaAnalyseInput = {
      ...TARGET,
      size: 500,
      strategy: 'last',
    };
    expect(analyse).toHaveBeenCalledWith(expected);
    expect(store.getState()).toMatchObject({
      report: report(500),
      loading: false,
      elapsedMs: 42,
      error: undefined,
    });
  });

  it('reports a failed analysis as text and clears the report time', async () => {
    const store = createSchemaStore({
      target: TARGET,
      analyse: () => Promise.reject(new Error('The shell is not running.')),
    });
    await store.getState().analyse();
    expect(store.getState()).toMatchObject({
      loading: false,
      error: 'The shell is not running.',
      elapsedMs: undefined,
    });
  });

  it('drops a result that arrives after a newer analysis started', async () => {
    const resolvers: ((value: SchemaReport) => void)[] = [];
    const analyse = vi.fn<AnalyseCall>(
      () => new Promise<SchemaReport>((resolve) => resolvers.push(resolve)),
    );
    const store = createSchemaStore({ target: TARGET, analyse });

    const first = store.getState().analyse();
    const second = store.getState().analyse();
    resolvers[1]?.(report(200));
    await second;
    resolvers[0]?.(report(100));
    await first;

    expect(store.getState().report?.sampled).toBe(200);
  });

  it('turns sort, filter and open paths into state', () => {
    const store = createSchemaStore({ target: TARGET, analyse: vi.fn<AnalyseCall>() });
    store.getState().sortBy('name');
    store.getState().sortBy('name');
    store.getState().setPathText('cust');
    store.getState().setMixedOnly(true);
    store.getState().setSparseOnly(true);
    store.getState().toggleRow('customer');
    expect(store.getState()).toMatchObject({
      sort: { key: 'name', direction: 'desc' },
      filters: { text: 'cust', mixedOnly: true, sparseOnly: true },
      expanded: { customer: true },
    });
    store.getState().toggleRow('customer');
    expect(store.getState().expanded).toEqual({ customer: false });
  });
});
