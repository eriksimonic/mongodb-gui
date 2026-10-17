import type { Page } from '@playwright/test';
import { Binary, MongoClient, MongoServerError, type ClientSession } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

// Each journey gets its own database, so the tests stay independent and can run in any order.
const COLLECTION_DATABASE = 'diag_activity_coll';
const DB_STATS_DATABASE = 'diag_activity_dbstats';
const TOP_DATABASE = 'diag_activity_top';
const SESSIONS_DATABASE = 'diag_activity_sessions';

async function connectLocalDev(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
}

async function openLocalDevDiagnostics(page: Page): Promise<void> {
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Monitoring', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Diagnostics', exact: true }).click();
}

/** The value cell of one row in a stats table, found by the label in the first cell. */
function statValue(page: Page, label: string) {
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: label, exact: true }) })
    .getByRole('cell')
    .nth(1);
}

/** Same counting as the app's formatCount. */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Same units as formatBytes in packages/ui/src/diagnostics/format.ts, so the text can be compared. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Session ids of the server's local sessions, as hex, the same ids the Sessions tab shows. */
async function localSessionIds(client: MongoClient): Promise<string[]> {
  const rows = await client
    .db('admin')
    .aggregate([{ $listLocalSessions: {} }])
    .toArray();
  return rows.map((row) => (row['_id']['id'] as Binary).toString('hex'));
}

/** The lsid of a started session. The UUID is the value $listLocalSessions lists. */
function lsidOf(session: ClientSession): Binary {
  if (session.id === undefined) {
    throw new Error('The session has no id');
  }
  return session.id.id;
}

/** The running operations of one session, read from currentOp on the admin database. */
async function runningOperations(client: MongoClient, lsid: Binary): Promise<unknown[]> {
  return client
    .db('admin')
    .aggregate([{ $currentOp: { allUsers: true } }, { $match: { 'lsid.id': lsid } }])
    .toArray();
}

test('collection stats: document count and data size match the server', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  const collection = 'items';
  try {
    await client.db(COLLECTION_DATABASE).dropDatabase();
    await client
      .db(COLLECTION_DATABASE)
      .collection(collection)
      .insertMany(Array.from({ length: 25 }, (_, n) => ({ marker: 'diagnostics-activity', n })));

    // The side channel reads the count and the size from $collStats, the source of the panel.
    const count = await client.db(COLLECTION_DATABASE).collection(collection).countDocuments();
    const [collStats] = await client
      .db(COLLECTION_DATABASE)
      .collection(collection)
      .aggregate([{ $collStats: { count: {}, storageStats: {} } }])
      .toArray();
    expect(count).toBe(25);

    await connectLocalDev(page, wiring.url);
    await expect(
      page.getByRole('treeitem', { name: COLLECTION_DATABASE, exact: true }),
    ).toBeVisible();
    await page
      .getByRole('treeitem', { name: COLLECTION_DATABASE, exact: true })
      .press('ArrowRight');
    await page.getByRole('treeitem', { name: collection, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Collection', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Collection stats', exact: true }).click();

    await expect(statValue(page, 'Documents')).toHaveText(formatCount(count));
    await expect(statValue(page, 'Data size')).toHaveText(
      formatBytes(Number(collStats?.['storageStats']?.['size'])),
    );
  } finally {
    await client.close();
  }
});

test('database stats: collection and document counts match the server', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DB_STATS_DATABASE).dropDatabase();
    await client
      .db(DB_STATS_DATABASE)
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await client
      .db(DB_STATS_DATABASE)
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }]);

    const stats = await client.db(DB_STATS_DATABASE).command({ dbStats: 1 });
    expect(stats['collections']).toBe(2);
    expect(stats['objects']).toBe(5);

    await connectLocalDev(page, wiring.url);
    const database = page.getByRole('treeitem', { name: DB_STATS_DATABASE, exact: true });
    await expect(database).toBeVisible();
    await database.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Monitoring', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Database stats', exact: true }).click();

    await expect(statValue(page, 'Collections')).toHaveText(
      formatCount(Number(stats['collections'])),
    );
    await expect(statValue(page, 'Views')).toHaveText(formatCount(Number(stats['views'])));
    await expect(statValue(page, 'Documents')).toHaveText(formatCount(Number(stats['objects'])));
  } finally {
    await client.close();
  }
});

test('top: the namespace of our queries has a row, and the server lists it', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  const ns = `${TOP_DATABASE}.items`;
  try {
    await client.db(TOP_DATABASE).dropDatabase();
    await client
      .db(TOP_DATABASE)
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await Promise.all(
      [1, 2, 3].map(() => client.db(TOP_DATABASE).collection('items').find({}).toArray()),
    );

    // Top counts since the server started, so the namespace is listed once it has activity.
    const reply = await client.db('admin').command({ top: 1 });
    expect(Object.keys(reply['totals'] as Record<string, unknown>)).toContain(ns);

    await connectLocalDev(page, wiring.url);
    await openLocalDevDiagnostics(page);
    await page.getByRole('tab', { name: 'Top', exact: true }).click();
    await expect(page.getByRole('cell', { name: ns, exact: true })).toBeVisible();
  } finally {
    await client.close();
  }
});

test('connection pools: the tab shows the pool totals the server reports', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    // The host map is empty on a standalone server, and totals change with every request. So the
    // test checks that the server reports the three totals, and that the tab shows their labels.
    await client.db('admin').command({ ping: 1 });
    const pools = await client.db('admin').command({ connPoolStats: 1 });
    expect(typeof pools['totalInUse']).toBe('number');
    expect(typeof pools['totalAvailable']).toBe('number');
    expect(typeof pools['totalCreated']).toBe('number');

    await connectLocalDev(page, wiring.url);
    await openLocalDevDiagnostics(page);
    await page.getByRole('tab', { name: 'Connection pools', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'In use', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Available', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Created', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Host', exact: true })).toBeVisible();
  } finally {
    await client.close();
  }
});

test('sessions: kill interrupts the running operation of the chosen session', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  const session = client.startSession();
  try {
    await client.db(SESSIONS_DATABASE).dropDatabase();
    await client
      .db(SESSIONS_DATABASE)
      .collection('items')
      .insertMany(Array.from({ length: 30 }, (_, n) => ({ n })));
    const lsid = lsidOf(session);
    const sessionId = lsid.toString('hex');

    // The $where sleeps for each document, so the find runs for about 30 seconds unless killed.
    const running = client
      .db(SESSIONS_DATABASE)
      .collection('items')
      .find({ $where: 'sleep(1000) || true' }, { session })
      .toArray()
      .then(
        () => 'finished',
        (error: MongoServerError) => error.codeName,
      );

    // The find reaches the server asynchronously, so poll currentOp until it runs.
    await expect.poll(async () => (await runningOperations(client, lsid)).length).toBe(1);
    expect(await localSessionIds(client)).toContain(sessionId);

    await connectLocalDev(page, wiring.url);
    await openLocalDevDiagnostics(page);
    await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
    await expect(page.getByRole('cell', { name: sessionId, exact: true })).toBeVisible();

    // Kill only our session. Kill all of user would end the app's own sessions.
    await page.getByRole('checkbox', { name: `Select session ${sessionId}`, exact: true }).check();
    await page.getByRole('button', { name: 'Kill selected (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Kill sessions', exact: true }).click();

    // The server reports the find as interrupted. The session record stays in the local list
    // after the kill, so the check uses the operation, not the session row.
    expect(await running).toBe('Interrupted');
    expect(await runningOperations(client, lsid)).toHaveLength(0);
  } finally {
    await session.endSession();
    await client.close();
  }
});
