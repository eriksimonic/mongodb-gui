import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

const execFileAsync = promisify(execFile);
const mongodump = resolve(
  import.meta.dirname,
  '../../../../packages/app/resources/mongo-tools/linux-x64/bin/mongodump',
);

test('restore a dump into a new database, read it back', async ({ page, wiring }) => {
  const dumpDir = test.info().outputPath('dump');
  const uri = mongoUriFromEnv();
  const client = new MongoClient(uri);
  try {
    // Start from nothing. Both databases are this journey's own.
    await client.db('restore_source').dropDatabase();
    await client.db('restore_journey').dropDatabase();
    await client
      .db('restore_source')
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    // A stale dump from an earlier run must not satisfy the test. Start the folder empty.
    rmSync(dumpDir, { recursive: true, force: true });
    mkdirSync(dumpDir, { recursive: true });
    // The dump is a database folder, the layout the restore dialog takes from "Choose folder".
    await execFileAsync(mongodump, ['--uri', uri, '--db', 'restore_source', '--out', dumpDir]);
    // The restore can only bring the data back from the dump.
    await client.db('restore_source').dropDatabase();

    wiring.setDialogPicks([join(dumpDir, 'restore_source')]);

    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Backup', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Restore…', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Restore into Local dev' });
    await dialog.getByRole('button', { name: 'Choose folder…', exact: true }).click();
    // The rename row appears once the folder is read. Rename the database to a new name.
    const target = dialog.getByRole('textbox', { name: 'Restore restore_source as', exact: true });
    await expect(target).toHaveValue('restore_source');
    await target.fill('restore_journey');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog.getByText('Restore finished', { exact: true })).toBeVisible();

    // Read the restored documents through the second client, not through the UI.
    const restored = await client
      .db('restore_journey')
      .collection<{ n: number }>('items')
      .find({}, { projection: { _id: 0, n: 1 } })
      .sort({ n: 1 })
      .toArray();
    expect(restored.map((doc) => doc.n)).toEqual([1, 2, 3, 4]);
    // The restore must not leave the source behind as a copy.
    const names = (await client.db('admin').admin().listDatabases()).databases.map(
      (item) => item.name,
    );
    expect(names).not.toContain('restore_source');
  } finally {
    await client.close();
  }
});
