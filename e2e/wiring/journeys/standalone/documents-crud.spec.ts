import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

interface Item {
  name: string;
  kind: string;
  qty: number;
}

/** Connects Local dev and expands one database. */
async function openDatabase(page: Page, url: string, database: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: database, exact: true }).click();
  await page.keyboard.press('ArrowRight');
}

/** Replaces the text of the Monaco editor that has focus. */
async function typeIntoEditor(page: Page, scope: ReturnType<Page['locator']>, text: string) {
  await scope.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
  // Monaco closes quotes and braces as text goes in. Delete what follows the cursor.
  await page.keyboard.press('ControlOrMeta+Shift+End');
  await page.keyboard.press('Delete');
}

test('documents panel: insert, edit, delete, count and delete by filter reach the server', async ({
  page,
  wiring,
}) => {
  const database = `wiring_documents_${randomBytes(4).toString('hex')}`;
  const client = new MongoClient(mongoUriFromEnv());
  const items = client.db(database).collection<Item>('items');
  const names = async (): Promise<string[]> =>
    (
      await items
        .find({}, { projection: { _id: 0, name: 1 } })
        .sort({ name: 1 })
        .toArray()
    ).map((document) => document.name);
  try {
    await items.insertMany([
      { name: 'seed-a', kind: 'seed', qty: 1 },
      { name: 'seed-b', kind: 'seed', qty: 2 },
      { name: 'keep-c', kind: 'keep', qty: 3 },
    ]);

    await openDatabase(page, wiring.url, database);
    await page.getByRole('treeitem', { name: 'items', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Manage documents', exact: true }).click();

    // sampleDocuments fills the table with the three seeded rows.
    await expect(page.getByText('Showing 3 of the first 20 documents')).toBeVisible();
    const rows = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'seed-a' }) });
    await expect(rows).toHaveCount(1);

    // insertDocument
    await page.getByRole('button', { name: 'Insert document', exact: true }).click();
    const insertDialog = page.getByRole('dialog', { name: 'Insert document in items' });
    await typeIntoEditor(
      page,
      insertDialog,
      JSON.stringify({ name: 'inserted-d', kind: 'seed', qty: 4 }),
    );
    await insertDialog.getByRole('button', { name: 'Insert', exact: true }).click();
    // The panel does not reload after a write, so the server is the source of truth from here.
    await expect.poll(names).toEqual(['inserted-d', 'keep-c', 'seed-a', 'seed-b']);

    // replaceDocument. Edit replaces the document that has the same _id.
    const before = await items.findOne({ name: 'keep-c' });
    if (before === null) {
      throw new Error('The seeded keep-c document is missing.');
    }
    const keepRow = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'keep-c' }) });
    await keepRow.getByRole('button', { name: 'Edit document', exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit document in items' });
    await typeIntoEditor(
      page,
      editDialog,
      JSON.stringify({ _id: { $oid: String(before._id) }, name: 'replaced-c', kind: 'keep' }),
    );
    await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editDialog).toBeHidden();
    await expect
      .poll(() => items.findOne({ _id: before._id }))
      .toEqual({ _id: before._id, name: 'replaced-c', kind: 'keep' });

    // countDocuments. Three documents have kind seed.
    const seedCount = await items.countDocuments({ kind: 'seed' });
    expect(seedCount).toBe(3);
    await page.getByRole('textbox', { name: 'Filter', exact: true }).fill('{"kind": "seed"}');
    await page.getByRole('button', { name: 'Count matches', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Delete ${seedCount} matching`, exact: true }),
    ).toBeVisible();

    // deleteByFilter, confirmed with the count the panel showed.
    await page.getByRole('button', { name: `Delete ${seedCount} matching`, exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete matching documents' })
      .getByRole('button', { name: `Delete ${seedCount} documents`, exact: true })
      .click();
    await expect.poll(names).toEqual(['replaced-c']);

    // deleteDocuments. The row action deletes by _id.
    await page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'replaced-c' }) })
      .getByRole('button', { name: 'Delete document', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Delete document' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect.poll(() => items.countDocuments({})).toBe(0);
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});

test('result tree: editing a field writes it with updateDocumentFields', async ({
  page,
  wiring,
}) => {
  const database = `wiring_documents_${randomBytes(4).toString('hex')}`;
  const client = new MongoClient(mongoUriFromEnv());
  const items = client.db(database).collection<Item>('items');
  try {
    await items.insertOne({ name: 'tree-a', kind: 'tree', qty: 5 });

    await openDatabase(page, wiring.url, database);
    await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.insertText('db.items.find({})');
    await page.keyboard.press('F5');

    await page
      .getByRole('radiogroup', { name: 'Result view' })
      .getByText('Tree', { exact: true })
      .click();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await page.getByRole('button', { name: 'Edit qty', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'New value for qty', exact: true });
    await input.fill('42');
    await page.getByRole('button', { name: 'Save value', exact: true }).click();
    await expect(input).toBeHidden();

    const saved = await items.findOne({ name: 'tree-a' });
    expect(saved?.qty).toBe(42);
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});
