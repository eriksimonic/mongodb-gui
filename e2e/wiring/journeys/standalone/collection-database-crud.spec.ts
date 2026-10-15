import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

test('create a database and collections, rename, clear and drop them, the server agrees', async ({
  page,
  wiring,
}) => {
  const database = `wiring_collection_database_${randomBytes(4).toString('hex')}`;
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();

    // createDatabase, through the connection menu.
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New database', exact: true }).click();
    await page.getByLabel('Database name').fill(database);
    await page.getByLabel('Initial collection name').fill('first');
    await page.getByRole('button', { name: 'Create database', exact: true }).click();
    const databaseItem = page.getByRole('treeitem', { name: database, exact: true });
    await expect(databaseItem).toBeVisible();
    expect(await client.db(database).listCollections().toArray()).toHaveLength(1);

    // createCollection, through the database menu.
    await databaseItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New collection', exact: true }).click();
    await page.getByLabel('Collection name').fill('second');
    await page.getByRole('button', { name: 'Create collection', exact: true }).click();
    await expect(async () => {
      const names = (await client.db(database).listCollections().toArray()).map((c) => c.name);
      expect(names.sort()).toEqual(['first', 'second']);
    }).toPass();

    // Expand the database so the collections show in the tree.
    await databaseItem.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('treeitem', { name: 'second', exact: true })).toBeVisible();

    // renameCollection
    await page.getByRole('treeitem', { name: 'second', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByLabel('New name').fill('renamed');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'renamed', exact: true })).toBeVisible();
    await expect(async () => {
      const names = (await client.db(database).listCollections().toArray()).map((c) => c.name);
      expect(names.sort()).toEqual(['first', 'renamed']);
    }).toPass();

    // clearCollection, on a collection with documents the second client wrote.
    await client
      .db(database)
      .collection('renamed')
      .insertMany([{ n: 1 }, { n: 2 }]);
    await page.getByRole('treeitem', { name: 'renamed', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear', exact: true }).click();
    await expect(page.getByText('Delete all 2 documents', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Clear collection', exact: true }).click();
    await expect(async () => {
      expect(await client.db(database).collection('renamed').countDocuments()).toBe(0);
    }).toPass();
    expect(await client.db(database).listCollections({ name: 'renamed' }).toArray()).toHaveLength(
      1,
    );

    // dropCollection
    await page.getByRole('treeitem', { name: 'renamed', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop', exact: true }).click();
    await page.getByLabel('Type renamed to confirm').fill('renamed');
    await page.getByRole('button', { name: 'Drop collection', exact: true }).click();
    await expect(async () => {
      const names = (await client.db(database).listCollections().toArray()).map((c) => c.name);
      expect(names).toEqual(['first']);
    }).toPass();

    // dropDatabase
    await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop database', exact: true }).click();
    await page.getByLabel(`Type ${database} to confirm`).fill(database);
    await page.getByRole('button', { name: 'Drop database', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: database, exact: true })).toHaveCount(0);
    await expect(async () => {
      const { databases } = await client.db('admin').admin().listDatabases();
      expect(databases.map((d) => d.name)).not.toContain(database);
    }).toPass();
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});
