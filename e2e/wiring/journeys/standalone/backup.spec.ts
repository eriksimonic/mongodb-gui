import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

const run = promisify(execFile);
const SOURCE_DB = 'backup_journey';
const CHECK_DB = 'backup_journey_check';
const DOCUMENT_COUNT = 5;
const MONGORESTORE = join(
  import.meta.dirname,
  '../../../../packages/app/resources/mongo-tools/linux-x64/bin/mongorestore',
);

test('back up a database, read the dump back', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(SOURCE_DB).dropDatabase();
    await client.db(CHECK_DB).dropDatabase();
    const documents = Array.from({ length: DOCUMENT_COUNT }, (_, index) => ({ n: index + 1 }));
    await client.db(SOURCE_DB).collection('items').insertMany(documents);
  } finally {
    await client.close();
  }

  // The backup goes into an empty folder. The dialog picks it through the native folder dialog.
  const folder = test.info().outputPath('backup');
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  wiring.setDialogPicks([folder]);

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: SOURCE_DB, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Import and backup', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Back up database…', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: `Back up ${SOURCE_DB}` });
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();
  // The name sets the file name, so the dump path is known before the run.
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('dump');
  await dialog.getByRole('button', { name: 'Start backup', exact: true }).click();
  await expect(dialog.getByText('Backup finished', { exact: true })).toBeVisible();

  // Read the dump back with the bundled mongorestore, into a database of its own.
  const archive = join(folder, 'dump.archive.gz');
  await run(MONGORESTORE, [
    `--uri=${mongoUriFromEnv()}`,
    `--archive=${archive}`,
    '--gzip',
    `--nsFrom=${SOURCE_DB}.*`,
    `--nsTo=${CHECK_DB}.*`,
  ]);

  // Check the restored rows through a second client, not through the UI.
  const check = new MongoClient(mongoUriFromEnv());
  let restored: { n: number }[];
  try {
    restored = await check
      .db(CHECK_DB)
      .collection<{ n: number }>('items')
      .find({}, { projection: { _id: 0, n: 1 } })
      .sort({ n: 1 })
      .toArray();
  } finally {
    await check.close();
  }
  expect(restored).toEqual(
    Array.from({ length: DOCUMENT_COUNT }, (_, index) => ({ n: index + 1 })),
  );
});
