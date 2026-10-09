import { toProfileEntry, type ProfileEntry } from '@mongo-gui/core';

/**
 * One kind of slow operation. Raw documents go through toProfileEntry, the same conversion the
 * adapter uses on system.profile, so the mock rows have the shape the router returns.
 */
interface OperationSpec {
  readonly ns: string;
  readonly op: 'command' | 'update' | 'insert' | 'remove' | 'getmore';
  readonly command: Record<string, unknown>;
  readonly planSummary?: string;
  readonly docsExamined?: number;
  readonly keysExamined?: number;
  readonly nreturned?: number;
  readonly millis: number;
  readonly client: string;
  readonly appName?: string;
  readonly errMsg?: string;
  readonly errCode?: number;
}

const SPECS: readonly OperationSpec[] = [
  {
    ns: 'shop.orders',
    op: 'command',
    command: { find: 'orders', filter: { status: 'paid' }, sort: { createdAt: -1 }, limit: 50 },
    planSummary: 'COLLSCAN',
    docsExamined: 1200,
    keysExamined: 0,
    nreturned: 50,
    millis: 340,
    client: '10.0.0.12',
    appName: 'checkout-api',
  },
  {
    ns: 'shop.orders',
    op: 'command',
    command: {
      find: 'orders',
      filter: { status: 'pending', createdAt: { $gt: '2026-01-01' } },
      limit: 20,
    },
    planSummary: 'IXSCAN { status: 1, createdAt: -1 }',
    docsExamined: 52,
    keysExamined: 52,
    nreturned: 48,
    millis: 9,
    client: '10.0.0.12',
    appName: 'checkout-api',
  },
  {
    ns: 'shop.customers',
    op: 'command',
    command: { find: 'customers', filter: { email: 'ada@example.com' } },
    planSummary: 'IXSCAN { email: 1 }',
    docsExamined: 1,
    keysExamined: 1,
    nreturned: 1,
    millis: 2,
    client: '10.0.0.31',
    appName: 'admin-console',
  },
  {
    ns: 'shop.orders',
    op: 'update',
    command: { q: { status: 'paid', shipped: { $exists: false } }, u: { $set: { shipped: true } } },
    planSummary: 'COLLSCAN',
    docsExamined: 1200,
    keysExamined: 0,
    millis: 115,
    client: '10.0.0.40',
    appName: 'fulfilment-worker',
  },
  {
    ns: 'shop.orders',
    op: 'command',
    command: {
      aggregate: 'orders',
      pipeline: [
        { $match: { status: 'paid' } },
        { $group: { _id: '$customerId', total: { $sum: '$amount' } } },
      ],
      cursor: {},
    },
    planSummary: 'COLLSCAN',
    docsExamined: 1200,
    keysExamined: 0,
    nreturned: 340,
    millis: 780,
    client: '10.0.0.12',
    appName: 'reports',
  },
  {
    ns: 'analytics.events',
    op: 'command',
    command: { find: 'events', filter: { $where: 'sleep(60) || true' } },
    planSummary: 'COLLSCAN',
    docsExamined: 5400,
    keysExamined: 0,
    nreturned: 0,
    millis: 4200,
    client: '10.0.0.52',
    appName: 'metrics-agent',
    errMsg: 'operation exceeded time limit',
    errCode: 50,
  },
  {
    ns: 'analytics.events',
    op: 'command',
    command: { find: 'events', filter: { userId: 'u-1042', type: 'click' }, sort: { ts: -1 } },
    planSummary: 'IXSCAN { userId: 1, type: 1 }',
    docsExamined: 310,
    keysExamined: 310,
    nreturned: 12,
    millis: 26,
    client: '10.0.0.52',
    appName: 'metrics-agent',
  },
  {
    ns: 'shop.customers',
    op: 'insert',
    command: { insert: 'customers', documents: [{ name: 'Grace' }] },
    millis: 4,
    client: '10.0.0.31',
    appName: 'admin-console',
    nreturned: 0,
    errMsg: 'E11000 duplicate key error collection: shop.customers index: email_1',
    errCode: 11000,
  },
  {
    ns: 'shop.orders',
    op: 'remove',
    command: { q: { status: 'cancelled' }, limit: 0 },
    planSummary: 'IXSCAN { status: 1 }',
    docsExamined: 14,
    keysExamined: 14,
    millis: 12,
    client: '10.0.0.40',
    appName: 'fulfilment-worker',
  },
  {
    ns: 'analytics.events',
    op: 'getmore',
    command: { getMore: 4_821_930_112, collection: 'events', batchSize: 101 },
    millis: 37,
    client: '10.0.0.52',
    appName: 'metrics-agent',
  },
];

/** Builds one raw system.profile document for the spec at the given time. */
function rawDocument(spec: OperationSpec, at: Date, index: number, millis: number): unknown {
  return {
    op: spec.op,
    ns: spec.ns,
    command: spec.command,
    ts: at,
    millis,
    opid: 1000 + index,
    ...(spec.planSummary === undefined ? {} : { planSummary: spec.planSummary }),
    ...(spec.docsExamined === undefined ? {} : { docsExamined: spec.docsExamined }),
    ...(spec.keysExamined === undefined ? {} : { keysExamined: spec.keysExamined }),
    ...(spec.nreturned === undefined ? {} : { nreturned: spec.nreturned }),
    client: spec.client,
    ...(spec.appName === undefined ? {} : { appName: spec.appName }),
    ...(spec.errMsg === undefined ? {} : { errMsg: spec.errMsg }),
    ...(spec.errCode === undefined ? {} : { errCode: spec.errCode }),
  };
}

/** The entry for the n-th operation, `ageMs` before `nowMs`. Durations vary by n so the table sorts. */
export function fixtureEntry(index: number, nowMs: number, ageMs: number): ProfileEntry {
  const spec = SPECS[index % SPECS.length] ?? SPECS[0];
  if (spec === undefined) {
    throw new Error('no profiler fixture specs');
  }
  const variation = 1 + ((index * 37) % 11) / 10;
  const millis = Math.round(spec.millis * variation);
  return toProfileEntry(rawDocument(spec, new Date(nowMs - ageMs), index, millis));
}

/** Fixture rows for the shop database (orders, customers) and the analytics database (events). */
export function fixtureProfileEntries(nowMs: number): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  for (let index = 0; index < 36; index += 1) {
    entries.push(fixtureEntry(index, nowMs, index * 90_000 + 4_000));
  }
  return entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

/** The next tail row, `index` operations after the fixtures. */
export function tailEntry(index: number, nowMs: number): ProfileEntry {
  return fixtureEntry(index, nowMs, 0);
}
