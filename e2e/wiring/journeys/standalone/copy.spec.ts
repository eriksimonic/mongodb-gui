import type { Locator, Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

const DOCUMENT_COUNT = 5;
const SAMPLE = Array.from({ length: DOCUMENT_COUNT }, (_, index) => ({ n: index + 1 }));

/** Drops the databases of this journey, then puts the sample collection into the source. */
async function seedSource(source: string, databases: readonly string[]) {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    for (const database of databases) {
      await client.db(database).dropDatabase();
    }
    await client.db(source).collection('items').insertMany(SAMPLE);
  } finally {
    await client.close();
  }
}

/** The values of `n` in a collection, read through a second client and not the UI. */
async function readValues(database: string, collection: string): Promise<number[]> {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const documents = await client
      .db(database)
      .collection<{ n: number }>(collection)
      .find({}, { projection: { _id: 0, n: 1 } })
      .sort({ n: 1 })
      .toArray();
    return documents.map((document) => document.n);
  } finally {
    await client.close();
  }
}

async function connectLocalDev(page: Page) {
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
}

/** Opens Copy to… for the `items` collection of a database in the tree. */
async function openCopyDialog(page: Page, database: string): Promise<Locator> {
  await page.getByRole('treeitem', { name: database, exact: true }).press('ArrowRight');
  const collection = page.getByRole('treeitem', { name: 'items', exact: true });
  await collection.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Import and export', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Copy to…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Copy collection', exact: true });
}

test('copy a collection to a renamed collection in another database, read the copy back', async ({
  page,
  wiring,
}) => {
  const source = 'copy_journey';
  const target = 'copy_journey_target';
  await seedSource(source, [source, target]);

  await page.goto(wiring.url);
  await connectLocalDev(page);
  const dialog = await openCopyDialog(page, source);

  await dialog.getByRole('textbox', { name: 'Target database', exact: true }).fill(target);
  await dialog.getByRole('textbox', { name: 'Target collection', exact: true }).fill('items_copy');
  const start = dialog.getByRole('button', { name: 'Start copy', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(dialog).toBeHidden();

  const progress = page.getByRole('dialog', { name: 'Copy progress', exact: true });
  await expect(progress.getByText('Copy finished', { exact: true })).toBeVisible();
  await progress.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(progress).toBeHidden();

  expect(await readValues(target, 'items_copy')).toEqual(SAMPLE.map((document) => document.n));
  expect(await readValues(source, 'items')).toEqual(SAMPLE.map((document) => document.n));
});

test('a production target asks for the typed database name before the copy starts', async ({
  page,
  wiring,
}) => {
  const source = 'copy_prod_journey';
  const target = 'copy_prod_journey_target';
  await seedSource(source, [source, target]);

  await page.goto(wiring.url);
  // The flag is set in the edit dialog of the saved connection.
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit connection', exact: true });
  await edit.getByRole('checkbox', { name: 'Production', exact: true }).check();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toBeHidden();

  // The PROD mark is on the row, and the row points at the production description.
  const localDev = page.getByRole('treeitem', { name: 'Local dev', exact: true });
  await expect(localDev.getByText('PROD', { exact: true })).toBeVisible();
  await expect(localDev).toHaveAccessibleDescription('Production connection');

  await connectLocalDev(page);
  const dialog = await openCopyDialog(page, source);
  await dialog.getByRole('textbox', { name: 'Target database', exact: true }).fill(target);

  const start = dialog.getByRole('button', { name: 'Start copy', exact: true });
  const confirm = dialog.getByRole('textbox', { name: `Type ${target} to confirm`, exact: true });
  await expect(
    dialog.getByText(
      'Local dev is a production connection. Type the database name to copy into it.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  // Start also waits for the tools and both servers. Wait for that, so the gate is the blocker.
  await expect(dialog.getByText(/^Checking the /)).toBeHidden();
  await expect(confirm).toBeVisible();
  await expect(start).toBeDisabled();

  // The match is exact, so a name with a different case keeps Start disabled.
  await confirm.fill('Copy_prod_journey_target');
  await expect(start).toBeDisabled();
  await dialog.screenshot({ path: test.info().outputPath('copy-prod-gate.png') });

  await confirm.fill(target);
  await expect(start).toBeEnabled();
  await start.click();
  await expect(dialog).toBeHidden();

  const progress = page.getByRole('dialog', { name: 'Copy progress', exact: true });
  await expect(progress.getByText('Copy finished', { exact: true })).toBeVisible();
  await progress.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(progress).toBeHidden();

  expect(await readValues(target, 'items')).toEqual(SAMPLE.map((document) => document.n));
});
