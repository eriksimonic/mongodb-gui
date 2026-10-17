import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

test('create, hide, unhide and drop an index, and read the collection stats', async ({
  page,
  wiring,
}) => {
  const database = `wiring_indexes_${randomBytes(4).toString('hex')}`;
  const client = new MongoClient(mongoUriFromEnv());
  const items = client.db(database).collection('items');
  async function indexInfo(name: string) {
    return (await items.listIndexes().toArray()).find((index) => index.name === name);
  }
  try {
    // Create the data before connecting, so the catalog lists the database.
    await items.insertMany([{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }]);

    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    const databaseRow = page.getByRole('treeitem', { name: database, exact: true });
    await expect(databaseRow).toBeVisible();
    await databaseRow.press('ArrowRight');
    const collectionRow = page.getByRole('treeitem', { name: 'items', exact: true });
    await collectionRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Collection', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Indexes', exact: true }).click();

    // collections.indexes: only the _id index so far, which the tab counts. listIndexBuilds polls on open.
    await expect(page.getByRole('tab', { name: 'Indexes 1', exact: true })).toBeVisible();

    // management.createIndex
    await page.getByRole('button', { name: 'Create index', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Field 1', exact: true }).fill('sku');
    await dialog.getByRole('button', { name: 'Create index', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Indexes 2', exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'sku_1' });
    await expect(row).toBeVisible();
    const created = await indexInfo('sku_1');
    expect(created?.key).toEqual({ sku: 1 });
    expect(created?.hidden).toBeUndefined();

    // management.setIndexHidden, both ways
    // The buttons are in the detail pane of the selected index.
    await row.click();
    const detail = page.getByRole('region', { name: 'Index details' });
    await detail.getByRole('button', { name: 'Hide index', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Unhide index', exact: true })).toBeVisible();
    expect((await indexInfo('sku_1'))?.hidden).toBe(true);
    await detail.getByRole('button', { name: 'Unhide index', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Hide index', exact: true })).toBeVisible();
    expect((await indexInfo('sku_1'))?.hidden).not.toBe(true);

    // collections.stats through the Clear dialog, which shows the count. Cancel keeps the data.
    await collectionRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear', exact: true }).click();
    const clear = page.getByRole('dialog');
    await expect(clear.getByText(`Delete all 3 documents in ${database}.items.`)).toBeVisible();
    await clear.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(clear).toBeHidden();
    expect(await items.countDocuments()).toBe(3);

    // management.dropIndex, confirmed by typing the name
    await collectionRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Collection', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Indexes', exact: true }).click();
    await row.click();
    await detail.getByRole('button', { name: 'Drop', exact: true }).click();
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('textbox', { name: 'Type sku_1 to confirm' }).fill('sku_1');
    await confirm.getByRole('button', { name: 'Drop index', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Indexes 1', exact: true })).toBeVisible();
    expect(await indexInfo('sku_1')).toBeUndefined();
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});
