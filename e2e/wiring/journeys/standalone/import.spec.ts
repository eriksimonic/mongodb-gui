import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

interface Item {
  sku: string;
  qty: number;
}

const ITEMS: Item[] = [
  { sku: 'A1', qty: 3 },
  { sku: 'B2', qty: 5 },
  { sku: 'C3', qty: 8 },
];

test('import a file into a collection, read it back', async ({ page, wiring }) => {
  // The database gets its own name, and the side channel empties it first.
  // An empty collection makes the database show in the tree, so the import has a target.
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db('import_journey').dropDatabase();
    await client.db('import_journey').createCollection('items');
  } finally {
    await client.close();
  }

  // A JSON array with three documents. Format detection reads the .json file as a JSON array.
  const filePath = test.info().outputPath('import-items.json');
  writeFileSync(filePath, JSON.stringify(ITEMS, null, 2));
  wiring.setDialogPicks([filePath]);

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  // Expand import_journey with the keyboard, the same way the connect journey expands shop.
  const database = page.getByRole('treeitem', { name: 'import_journey', exact: true });
  await database.press('ArrowRight');
  await page.getByRole('treeitem', { name: 'items', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Import and export', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Import data', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Import data' });
  await dialog.getByRole('button', { name: 'Browse', exact: true }).click();
  await expect(dialog.getByLabel('File path')).toHaveValue(filePath);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  // The preview shows the sample rows. Next goes to the options step.
  await expect(dialog.getByText('Detected JSON array')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start import', exact: true }).click();

  await expect(dialog.getByText('Import finished', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(
      `Inserted ${ITEMS.length}, updated 0, failed 0 of ${ITEMS.length} records into import_journey.items.`,
      { exact: true },
    ),
  ).toBeVisible();

  // Read the documents through a second client, so the check does not trust the UI.
  const reader = new MongoClient(mongoUriFromEnv());
  let items: Item[];
  try {
    items = await reader
      .db('import_journey')
      .collection<Item>('items')
      .find({}, { projection: { _id: 0, sku: 1, qty: 1 } })
      .sort({ sku: 1 })
      .toArray();
  } finally {
    await reader.close();
  }
  expect(items).toEqual(ITEMS);
});
