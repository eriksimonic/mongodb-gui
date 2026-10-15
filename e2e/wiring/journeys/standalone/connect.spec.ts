import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

test('connect to a standalone server, list databases and collections, disconnect', async ({
  page,
  wiring,
}) => {
  // Read the catalog through a second client, so the check does not trust the UI.
  // The tree lists every database the server returns, admin, config and local included.
  // The catalog drops system.* collections, so the check drops them too.
  const client = new MongoClient(mongoUriFromEnv());
  let databaseNames: string[];
  let collectionNames: string[];
  try {
    const { databases } = await client.db('admin').admin().listDatabases();
    databaseNames = databases.map((database) => database.name);
    const collections = await client.db('shop').listCollections({}, { nameOnly: true }).toArray();
    collectionNames = collections
      .map((collection) => collection.name)
      .filter((name) => !name.startsWith('system.'));
  } finally {
    await client.close();
  }
  expect(databaseNames).toContain('shop');
  expect(collectionNames).toContain('orders');

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  // Connecting opens the connection node, so its databases show.
  for (const name of databaseNames) {
    await expect(page.getByRole('treeitem', { name, exact: true })).toBeVisible();
  }

  // Expand shop with the keyboard. The chevron has no role, so ArrowRight does the job.
  const shop = page.getByRole('treeitem', { name: 'shop', exact: true });
  await shop.press('ArrowRight');
  for (const name of collectionNames) {
    await expect(page.getByRole('treeitem', { name, exact: true })).toBeVisible();
  }

  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  for (const name of databaseNames) {
    await expect(page.getByRole('treeitem', { name, exact: true })).toHaveCount(0);
  }
});
