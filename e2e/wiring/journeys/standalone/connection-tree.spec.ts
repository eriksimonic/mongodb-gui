import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { MONGO_ROOT_PASSWORD, mongoUriFromEnv } from '../../../support/mongo';

/**
 * Lists the app's connections on the server, one entry per connection with the user names it is
 * authenticated as. A connection without credentials has an empty list.
 */
async function appConnectionUsers(client: MongoClient): Promise<string[][]> {
  const ops = await client
    .db('admin')
    .aggregate<{ users?: string[] }>([
      { $currentOp: { idleConnections: true, allUsers: true } },
      { $match: { appName: 'mongo-gui' } },
      { $project: { _id: 0, users: '$effectiveUsers.user' } },
    ])
    .toArray();
  return ops.map((op) => op.users ?? []);
}

test('refresh shows a collection created and dropped through the side channel', async ({
  page,
  wiring,
}) => {
  const database = 'conn_tree_refresh';
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(database).dropDatabase();
    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();
    // The tree lists databases from the last load. The new database is not there until a refresh.
    await expect(page.getByRole('treeitem', { name: database, exact: true })).toHaveCount(0);

    // Two collections. The database would vanish from the server list once it is empty, so the
    // second collection keeps it there after the first one is dropped.
    await client.db(database).createCollection('items');
    await client.db(database).createCollection('anchor');
    const created = await client.db(database).listCollections({}, { nameOnly: true }).toArray();
    expect(created.map((collection) => collection.name).sort()).toEqual(['anchor', 'items']);

    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
    const databaseRow = page.getByRole('treeitem', { name: database, exact: true });
    await expect(databaseRow).toBeVisible();
    // A new database node starts collapsed, so expand it to see its collections.
    await databaseRow.press('ArrowRight');
    await expect(page.getByRole('treeitem', { name: 'items', exact: true })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'anchor', exact: true })).toBeVisible();

    await client.db(database).collection('items').drop();
    const remaining = await client.db(database).listCollections({}, { nameOnly: true }).toArray();
    expect(remaining.map((collection) => collection.name)).toEqual(['anchor']);

    // The database node was expanded before this refresh and stays expanded, so the dropped
    // collection's row goes and the other one remains.
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'items', exact: true })).toHaveCount(0);
    await expect(page.getByRole('treeitem', { name: 'anchor', exact: true })).toBeVisible();
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});

test('ArrowRight expands a database into its collections, ArrowLeft hides them', async ({
  page,
  wiring,
}) => {
  const database = 'conn_tree_expand';
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(database).dropDatabase();
    await client.db(database).createCollection('orders');
    await client.db(database).createCollection('items');
    // The expected names come from the server, so the tree is checked against the server.
    const collections = await client.db(database).listCollections({}, { nameOnly: true }).toArray();
    const collectionNames = collections.map((collection) => collection.name);

    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    const databaseRow = page.getByRole('treeitem', { name: database, exact: true });
    await expect(databaseRow).toBeVisible();
    await expect(databaseRow).toHaveAttribute('aria-expanded', 'false');

    await databaseRow.press('ArrowRight');
    for (const name of collectionNames) {
      await expect(page.getByRole('treeitem', { name, exact: true })).toBeVisible();
    }

    await databaseRow.press('ArrowLeft');
    await expect(databaseRow).toHaveAttribute('aria-expanded', 'false');
    for (const name of collectionNames) {
      await expect(page.getByRole('treeitem', { name, exact: true })).toHaveCount(0);
    }
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});

test('a wrong password shows an error, the right password connects to shop', async ({
  page,
  wiring,
}) => {
  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Secured dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill('wrong-password');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  // The dialog stays open with the error, so the user can try again.
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toHaveCount(0);

  await dialog.getByLabel('Password', { exact: true }).fill(MONGO_ROOT_PASSWORD);
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();

  // The app's connection now authenticates as root, so the server shows root on one of its connections.
  const client = new MongoClient(mongoUriFromEnv());
  try {
    expect((await appConnectionUsers(client)).flat()).toContain('root');
  } finally {
    await client.close();
  }
});

test('cancelling the password dialog leaves the secured connection unconnected', async ({
  page,
  wiring,
}) => {
  await page.goto(wiring.url);
  const securedRow = page.getByRole('treeitem', { name: 'Secured dev', exact: true });
  await securedRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Cancel does not connect. The row keeps the error from the failed connect, with no databases.
  await expect(securedRow.getByLabel('Connection error', { exact: true })).toBeVisible();
  await expect(securedRow.getByLabel('Connected', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toHaveCount(0);

  // No connection of the app is authenticated, because the password was never given.
  const client = new MongoClient(mongoUriFromEnv());
  try {
    expect((await appConnectionUsers(client)).flat()).not.toContain('root');
  } finally {
    await client.close();
  }
});

test('connection status shows connected after connect and disconnected after disconnect', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await page.goto(wiring.url);
    const localRow = page.getByRole('treeitem', { name: 'Local dev', exact: true });
    await localRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await expect(localRow.getByLabel('Connected', { exact: true })).toBeVisible();
    // The status icon reports the app's state. The server must show the app's connection too.
    expect((await appConnectionUsers(client)).length).toBeGreaterThan(0);

    await localRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    await expect(localRow.getByLabel('Disconnected', { exact: true })).toBeVisible();
    await expect(localRow.getByLabel('Connected', { exact: true })).toHaveCount(0);
    // The driver closes its sockets asynchronously, so the server count falls after a delay.
    await expect.poll(async () => (await appConnectionUsers(client)).length).toBe(0);
  } finally {
    await client.close();
  }
});
